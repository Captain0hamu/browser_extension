import * as pdfjsLib from "./vendor/pdf.mjs";

const extension = globalThis.browser ?? globalThis.chrome;

pdfjsLib.GlobalWorkerOptions.workerSrc = extension.runtime.getURL("vendor/pdf.worker.mjs");

const fileInput = document.querySelector("#file-input");
const searchInput = document.querySelector("#search");
const showHiddenInput = document.querySelector("#show-hidden");
const copyButton = document.querySelector("#copy");
const downloadButton = document.querySelector("#download");
const status = document.querySelector("#status");
const results = document.querySelector("#results");
const pageTemplate = document.querySelector("#page-template");

let extractedText = "";
let documentName = "document";

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
  documentName = file.name.replace(/\.pdf$/i, "") || "document";
  searchInput.value = "";
  searchInput.disabled = true;
  copyButton.disabled = true;
  downloadButton.disabled = true;
  setStatus("PDFを読み込んでいます…");

  const bytes = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjsLib.getDocument({ data: bytes });
  const pdf = await loadingTask.promise;
  const pages = [];
  let hiddenCount = 0;

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    setStatus(`${pdf.numPages} ページ中 ${pageNumber} ページを抽出中…`);
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent({ includeMarkedContent: true });
    const text = textForPage(textContent.items);
    const candidates = hiddenTextCandidates(await page.getOperatorList());
    hiddenCount += candidates.length;
    pages.push(`--- Page ${pageNumber} ---\n${text}`);

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
    for (const group of candidateItemGroups(textContent.items, candidates)) {
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
  setStatus(`${pdf.numPages} ページを描画し、不可視候補 ${hiddenCount} 件を復元しました。`);
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
