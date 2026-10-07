const MANABA_HOST = "tid.manaba.jp";
const MENU_ID = "save-manaba-resource";

browser.contextMenus.create({
  id: MENU_ID,
  title: "このmanaba資料を授業フォルダーへ保存",
  contexts: ["link"],
  documentUrlPatterns: [`https://${MANABA_HOST}/*`]
});

function courseId(url) {
  const match = new URL(url).pathname.match(/(?:^|\/)course_(\d+)(?:[_/]|$)/);
  return match ? match[1] : null;
}

async function localSettings() {
  const saved = await browser.storage.local.get({ apiUrl: "http://127.0.0.1:8765", token: "" });
  return saved;
}

async function currentCookies() {
  const cookies = await browser.cookies.getAll({ domain: MANABA_HOST });
  return cookies.map(({ name, value, domain }) => ({ name, value, domain }));
}

async function notify(title, message) {
  await browser.notifications.create({ type: "basic", title, message });
}

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !info.linkUrl || !tab.url) return;
  const id = courseId(tab.url);
  if (!id) {
    await notify("manaba Folder Sync", "コースページ上で資料リンクを選択してください。");
    return;
  }
  const { apiUrl, token } = await localSettings();
  if (!token) {
    await notify("manaba Folder Sync", "拡張機能の設定画面でローカルAPIトークンを入力してください。");
    return;
  }
  try {
    const response = await fetch(`${apiUrl.replace(/\/$/, "")}/v1/downloads`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        url: info.linkUrl,
        course_id: id,
        referer: tab.url,
        cookies: await currentCookies()
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail || `HTTP ${response.status}`);
    await notify("manaba Folder Sync", `${result.filename}\n→ ${result.path}`);
  } catch (error) {
    await notify("manaba Folder Sync: 保存失敗", error.message);
  }
});
