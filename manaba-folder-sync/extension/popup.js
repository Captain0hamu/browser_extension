const status = document.querySelector("#status");
const results = document.querySelector("#results");
const generate = document.querySelector("#generate");
const copy = document.querySelector("#copy");
let toml = "";

function showList(id, values, describe) {
  const list = document.querySelector(id);
  list.replaceChildren(...values.map((value) => {
    const item = document.createElement("li");
    item.textContent = describe(value);
    return item;
  }));
  if (!values.length) {
    const item = document.createElement("li");
    item.textContent = "なし";
    list.append(item);
  }
}

function tomlString(value) {
  return JSON.stringify(value);
}

async function browserCookies() {
  const cookies = await browser.cookies.getAll({ domain: "tid.manaba.jp" });
  if (!cookies.length) throw new Error("manabaのCookieを取得できません。manabaを開いてログインし直してください。");
  return cookies.map(({ name, value, domain }) => ({ name, value, domain }));
}

generate.addEventListener("click", async () => {
  status.className = "";
  results.hidden = true;
  generate.disabled = true;
  status.textContent = "現行コースを確認しています…";
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || new URL(tab.url).hostname !== "tid.manaba.jp") {
      throw new Error("manabaを開いたタブで実行してください。");
    }
    const { apiUrl, token } = await browser.storage.local.get({ apiUrl: "http://127.0.0.1:8765", token: "" });
    if (!token) throw new Error("拡張機能の設定画面でローカルAPIトークンを入力してください。");
    let response;
    try {
      response = await fetch(`${apiUrl.replace(/\/$/, "")}/v1/courses/mapping-candidates`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ cookies: await browserCookies() })
      });
    } catch (_) {
      throw new Error("ローカルAPIに接続できません。サービスが起動しているか確認してください。");
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || `ローカルAPI エラー (${response.status})`);
    showList("#matches", data.matches, (item) => `${item.name} (${item.id}) → ${item.path}`);
    showList("#unmatched", data.unmatched_courses, (item) => `${item.name} (${item.id})`);
    showList("#registered", data.registered_courses, (item) => `${item.name} (${item.id}) → ${item.configured_path}`);
    showList("#unused", data.unused_folders, (item) => item);
    toml = data.matches.map((item) => `[courses.${tomlString(item.id)}]\nname = ${tomlString(item.name)}\npath = ${tomlString(item.path)}`).join("\n\n");
    copy.hidden = !toml;
    results.hidden = false;
    status.textContent = "候補を確認し、必要ならコピーして config.toml に手動で追加してください。";
  } catch (error) {
    status.className = "error";
    status.textContent = error.message;
  } finally {
    generate.disabled = false;
  }
});

copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(toml);
    status.textContent = "TOMLをコピーしました。config.toml を確認してから手動で追加してください。";
  } catch (_) {
    status.className = "error";
    status.textContent = "クリップボードへのコピーに失敗しました。Firefoxの権限設定を確認してください。";
  }
});
