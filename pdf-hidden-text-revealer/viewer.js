import * as pdfjsLib from "./vendor/pdf.mjs";
import { PDFDocument, degrees, rgb } from "./vendor/pdf-lib.esm.min.js";

const extension = globalThis.browser ?? globalThis.chrome;

pdfjsLib.GlobalWorkerOptions.workerSrc = extension.runtime.getURL("vendor/pdf.worker.mjs");

const fileInput = document.querySelector("#file-input");
const searchInput = document.querySelector("#search");
const showHiddenInput = document.querySelector("#show-hidden");
const copyButton = document.querySelector("#copy");
const downloadButton = document.querySelector("#download");
const downloadPdfButton = document.querySelector("#download-pdf");
const status = document.querySelector("#status");
const results = document.querySelector("#results");
const pageTemplate = document.querySelector("#page-template");

let extractedText = "";
let repairedPdfBytes = null;
let documentName = "document";

results.classList.toggle("hide-hidden-overlay", !showHiddenInput.checked);

function setStatus(message) {
  status.textContent = message;
}

function textForPage(items) {
  let text = "";
  for (const item of items) {
    if (item.str === undefined) continue;
    text += item.str;
    if (item.hasEOL) text += "\n";
  }
  return text.trim();
}

function operatorText(args) {
  return args
    .flat(Infinity)
    .filter((value) => value && typeof value === "object" && "unicode" in value)
    .map((glyph) => glyph.unicode)
    .join("");
}

function isNearlyWhite(color) {
  if (typeof color !== "string") return false;
  const match = color.match(/^#([0-9a-f]{6})$/i);
  if (!match) return false;
  const rgb = [0, 2, 4].map((index) => Number.parseInt(match[1].slice(index, index + 2), 16));
  return rgb.every((channel) => channel >= 245);
}

function fillAlphaFromGState(args, fallback) {
  const findAlpha = (value) => {
    if (Array.isArray(value)) {
      if (value[0] === "ca" && Number.isFinite(value[1])) return value[1];
      for (const nested of value) {
        const alpha = findAlpha(nested);
        if (alpha !== undefined) return alpha;
      }
    } else if (value && typeof value === "object" && Number.isFinite(value.ca)) {
      return value.ca;
    }
    return undefined;
  };
  return findAlpha(args) ?? fallback;
}

function hiddenTextCandidates(operatorList) {
  const OPS = pdfjsLib.OPS;
  let state = { fill: "#000000", renderingMode: 0, fillAlpha: 1 };
  const savedStates = [];
  const candidates = [];

  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const fn = operatorList.fnArray[index];
    const args = operatorList.argsArray[index];

    if (fn === OPS.save) {
      savedStates.push({ ...state });
      continue;
    }
    if (fn === OPS.restore) {
      state = savedStates.pop() || state;
      continue;
    }
    if (fn === OPS.setFillRGBColor) {
      state.fill = args[0];
      continue;
    }
    if (fn === OPS.setTextRenderingMode) {
      state.renderingMode = args[0];
      continue;
    }
    if (fn === OPS.setGState) {
      state.fillAlpha = fillAlphaFromGState(args, state.fillAlpha);
      continue;
    }
    if (fn !== OPS.showText && fn !== OPS.showSpacedText) continue;

    const text = operatorText(args).trim();
    if (!text) continue;
    let reason = null;
    if (state.renderingMode === 3 || state.renderingMode === 7) {
      reason = `テキスト描画モード ${state.renderingMode}（描画しない）`;
    } else if (state.fillAlpha <= 0.01) {
      reason = "塗りの不透明度 0";
    } else if (isNearlyWhite(state.fill)) {
      reason = `白系の塗り色 ${state.fill}`;
    }
    if (reason) candidates.push({ text, reason });
  }
  return candidates;
}

function canonicalText(value) {
  return value.normalize("NFKC").replace(/\s+/gu, "");
}

function candidateItemGroups(items, candidates) {
  const availableItems = items
    .map((item, index) => ({ item, index, text: item.str === undefined ? "" : canonicalText(item.str) }))
    .filter(({ text }) => text.length > 0);

  return candidates.map((candidate) => {
    const target = canonicalText(candidate.text);
    const exact = availableItems.find(({ text }) => text === target);
    if (exact) return { candidate, items: [exact.item] };

    for (let start = 0; start < availableItems.length; start += 1) {
      let combined = "";
      const matched = [];
      for (let current = start; current < availableItems.length; current += 1) {
        combined += availableItems[current].text;
        matched.push(availableItems[current].item);
        if (combined === target) return { candidate, items: matched };
        if (combined.length >= target.length || !target.startsWith(combined)) break;
      }
    }
    return { candidate, items: [] };
  });
}

function itemBounds(item, styles, viewport) {
  const transform = pdfjsLib.Util.transform(viewport.transform, item.transform);
  const style = styles[item.fontName] || {};
  const fontHeight = Math.hypot(transform[2], transform[3]);
  const fontAscent = style.ascent
    ? style.ascent * fontHeight
    : style.descent
      ? (1 + style.descent) * fontHeight
      : fontHeight;
  return {
    left: transform[4],
    top: transform[5] - fontAscent,
    width: Math.max(item.width * viewport.scale, fontHeight),
    height: Math.max(fontHeight, 1),
  };
}

function isNearlyUniform(imageData) {
  const counts = new Map();
  let dominant = 0;
  const pixels = imageData.data;
  const step = Math.max(1, Math.floor((imageData.width * imageData.height) / 12000));
  let sampled = 0;

  for (let pixel = 0; pixel < imageData.width * imageData.height; pixel += step) {
    const offset = pixel * 4;
    const key = `${pixels[offset] >> 4},${pixels[offset + 1] >> 4},${pixels[offset + 2] >> 4}`;
    const count = (counts.get(key) || 0) + 1;
    counts.set(key, count);
    dominant = Math.max(dominant, count);
    sampled += 1;
  }
  return sampled > 0 && dominant / sampled >= 0.985;
}

async function coveredTextGroups(page, textContent) {
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  await page.render({ canvasContext: context, viewport }).promise;

  const groups = [];
  for (const item of textContent.items) {
    if (!item.str?.trim()) continue;
    // Symbol-font bullets often decode only to a Private Use code point, which
    // cannot be re-encoded reliably as selectable Unicode text.
    if (/^[\p{Private_Use}\s]+$/u.test(item.str)) continue;
    const bounds = itemBounds(item, textContent.styles, viewport);
    const left = Math.max(0, Math.floor(bounds.left));
    const top = Math.max(0, Math.floor(bounds.top));
    const right = Math.min(canvas.width, Math.ceil(bounds.left + bounds.width));
    const bottom = Math.min(canvas.height, Math.ceil(bounds.top + bounds.height));
    if (right - left < 2 || bottom - top < 2) continue;
    const pixels = context.getImageData(left, top, right - left, bottom - top);
    if (isNearlyUniform(pixels)) {
      groups.push({
        candidate: { text: item.str, reason: "文字位置が単色（Box等による遮蔽候補）" },
        items: [item],
      });
    }
  }
  return groups;
}

function mergeCandidateGroups(...groupSets) {
  const merged = new Map();
  for (const groups of groupSets) {
    for (const group of groups) {
      for (const item of group.items) {
        const existing = merged.get(item);
        if (existing) {
          if (!existing.candidate.reason.includes(group.candidate.reason)) {
            existing.candidate.reason += ` / ${group.candidate.reason}`;
          }
        } else {
          merged.set(item, { candidate: { ...group.candidate }, items: [item] });
        }
      }
    }
  }
  return [...merged.values()];
}

function pageFontData(page, styles) {
  const fonts = {};
  for (const fontName of Object.keys(styles)) {
    try {
      const font = page.commonObjs.get(fontName);
      if (font?.data) fonts[fontName] = font.data;
    } catch (error) {
      console.warn(`フォント ${fontName} を取得できませんでした。`, error);
    }
  }
  return fonts;
}

function placeCandidateItem(container, item, styles, viewport, reason) {
  const transform = pdfjsLib.Util.transform(viewport.transform, item.transform);
  const style = styles[item.fontName] || {};
  let angle = Math.atan2(transform[1], transform[0]);
  if (style.vertical) angle += Math.PI / 2;

  const fontHeight = Math.hypot(transform[2], transform[3]);
  const fontAscent = style.ascent
    ? style.ascent * fontHeight
    : style.descent
      ? (1 + style.descent) * fontHeight
      : fontHeight;
  const width = Math.max(item.width * viewport.scale, fontHeight);

  const marker = document.createElement("span");
  marker.className = "hidden-text-marker";
  marker.textContent = item.str;
  marker.title = reason;
  marker.style.left = `${transform[4]}px`;
  marker.style.top = `${transform[5] - fontAscent}px`;
  marker.style.width = `${width}px`;
  marker.style.minHeight = `${fontHeight}px`;
  marker.style.fontSize = `${fontHeight}px`;
  marker.style.transform = `rotate(${angle}rad)`;
  container.append(marker);
}

async function repairPdf(sourceBytes, pageRecords) {
  const document = await PDFDocument.load(sourceBytes, { updateMetadata: false });
  document.registerFontkit(globalThis.fontkit);
  const pages = document.getPages();
  const embeddedFonts = new Map();

  for (let pageIndex = 0; pageIndex < pageRecords.length; pageIndex += 1) {
    const page = pages[pageIndex];
    const { groups, fonts } = pageRecords[pageIndex];
    for (const group of groups) {
      for (const item of group.items) {
        const fontData = fonts[item.fontName];
        if (!fontData) continue;
        let font = embeddedFonts.get(fontData);
        if (!font) {
          font = await document.embedFont(fontData, { subset: true });
          embeddedFonts.set(fontData, font);
        }
        const size = Math.max(Math.hypot(item.transform[2], item.transform[3]), 1);
        const angle = Math.atan2(item.transform[1], item.transform[0]);
        page.drawText(item.str, {
          x: item.transform[4],
          y: item.transform[5],
          size,
          font,
          color: rgb(0.07, 0.07, 0.07),
          rotate: degrees(angle * 180 / Math.PI),
        });
      }
    }
  }

  return document.save();
}

async function renderPage(page, canvas, pageWrap, viewport) {
  const pixelRatio = window.devicePixelRatio || 1;
  const context = canvas.getContext("2d", { alpha: false });
  canvas.width = Math.floor(viewport.width * pixelRatio);
  canvas.height = Math.floor(viewport.height * pixelRatio);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  pageWrap.style.width = `${viewport.width}px`;
  pageWrap.style.height = `${viewport.height}px`;

  await page.render({
    canvasContext: context,
    viewport,
    transform: pixelRatio === 1 ? null : [pixelRatio, 0, 0, pixelRatio, 0, 0],
  }).promise;
}

function applySearch() {
  const query = searchInput.value.trim().toLocaleLowerCase();
  for (const page of results.querySelectorAll(".page-result")) {
    page.classList.toggle("is-hidden", Boolean(query) && !page.textContent.toLocaleLowerCase().includes(query));
  }
}

async function extract(file) {
  results.replaceChildren();
  extractedText = "";
  repairedPdfBytes = null;
  documentName = file.name.replace(/\.pdf$/i, "") || "document";
  searchInput.value = "";
  searchInput.disabled = true;
  copyButton.disabled = true;
  downloadButton.disabled = true;
  downloadPdfButton.disabled = true;
  setStatus("PDFを読み込んでいます…");

  const sourceBytes = new Uint8Array(await file.arrayBuffer());
  const analysisTask = pdfjsLib.getDocument({
    data: sourceBytes.slice(),
    disableFontFace: true,
    fontExtraProperties: true,
  });
  const analysisPdf = await analysisTask.promise;
  const pages = [];
  const pageRecords = [];
  let hiddenCount = 0;

  for (let pageNumber = 1; pageNumber <= analysisPdf.numPages; pageNumber += 1) {
    setStatus(`${analysisPdf.numPages} ページ中 ${pageNumber} ページを解析中…`);
    const page = await analysisPdf.getPage(pageNumber);
    const textContent = await page.getTextContent({ includeMarkedContent: true });
    const text = textForPage(textContent.items);
    const candidates = hiddenTextCandidates(await page.getOperatorList());
    const attributeGroups = candidateItemGroups(textContent.items, candidates);
    const coveredGroups = await coveredTextGroups(page, textContent);
    const groups = mergeCandidateGroups(attributeGroups, coveredGroups);
    const mergedCandidates = groups.map(({ candidate }) => candidate);
    const fonts = pageFontData(page, textContent.styles);
    hiddenCount += groups.length;
    pages.push(`--- Page ${pageNumber} ---\n${text}`);
    pageRecords.push({ text, textContent, candidates: mergedCandidates, groups, fonts });
  }

  setStatus(`不可視候補 ${hiddenCount} 件をPDFへ書き込んでいます…`);
  repairedPdfBytes = await repairPdf(sourceBytes, pageRecords);
  const displayTask = pdfjsLib.getDocument({ data: repairedPdfBytes.slice() });
  const displayPdf = await displayTask.promise;

  for (let pageNumber = 1; pageNumber <= displayPdf.numPages; pageNumber += 1) {
    setStatus(`${displayPdf.numPages} ページ中 ${pageNumber} ページを描画中…`);
    const page = await displayPdf.getPage(pageNumber);
    const { text, textContent, candidates, groups } = pageRecords[pageNumber - 1];

    const clone = pageTemplate.content.cloneNode(true);
    const pageWrap = clone.querySelector(".page-canvas-wrap");
    const canvas = clone.querySelector("canvas");
    const overlay = clone.querySelector(".hidden-text-overlay");
    const viewport = page.getViewport({ scale: 1.35 });
    clone.querySelector("h2").textContent = `ページ ${pageNumber}${candidates.length ? ` — 不可視候補 ${candidates.length} 件` : ""}`;
    if (candidates.length) {
      const candidateBox = clone.querySelector(".hidden-candidates");
      const list = candidateBox.querySelector("ul");
      for (const candidate of candidates) {
        const item = document.createElement("li");
        const reason = document.createElement("code");
        reason.textContent = candidate.reason;
        item.append(reason, " ", candidate.text);
        list.append(item);
      }
      candidateBox.hidden = false;
    }
    for (const group of groups) {
      for (const item of group.items) {
        placeCandidateItem(overlay, item, textContent.styles, viewport, group.candidate.reason);
      }
    }
    clone.querySelector("pre").textContent = text || "（抽出できるテキストがありません）";
    results.append(clone);
    await renderPage(page, canvas, pageWrap, viewport);
  }

  extractedText = pages.join("\n\n");
  searchInput.disabled = false;
  copyButton.disabled = false;
  downloadButton.disabled = false;
  downloadPdfButton.disabled = false;
  setStatus(`${displayPdf.numPages} ページを修復し、不可視文字 ${hiddenCount} 件をPDFへ書き込みました。`);
}

fileInput.addEventListener("change", async () => {
  const [file] = fileInput.files;
  if (!file) return;
  try {
    await extract(file);
  } catch (error) {
    console.error(error);
    results.replaceChildren();
    setStatus(`読み込みに失敗しました: ${error.message}`);
  }
});

searchInput.addEventListener("input", applySearch);

showHiddenInput.addEventListener("change", () => {
  results.classList.toggle("hide-hidden-overlay", !showHiddenInput.checked);
});

copyButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(extractedText);
  setStatus("全テキストをクリップボードへコピーしました。");
});

downloadButton.addEventListener("click", () => {
  const blob = new Blob([extractedText], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${documentName}-extracted.txt`;
  link.click();
  URL.revokeObjectURL(url);
  setStatus("TXTファイルを保存しました。");
});

downloadPdfButton.addEventListener("click", () => {
  if (!repairedPdfBytes) return;
  const blob = new Blob([repairedPdfBytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${documentName}-repaired.pdf`;
  link.click();
  URL.revokeObjectURL(url);
  setStatus("修復済みPDFを保存しました。");
});
