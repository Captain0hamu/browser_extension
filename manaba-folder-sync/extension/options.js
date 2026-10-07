const apiUrl = document.querySelector("#apiUrl");
const token = document.querySelector("#token");
const status = document.querySelector("#status");

const autoSubmit = document.querySelector("#autoSubmit");
browser.storage.local.get({ apiUrl: "http://127.0.0.1:8765", token: "", autoSubmit: false }).then((value) => {
  apiUrl.value = value.apiUrl;
  token.value = value.token;
  autoSubmit.checked = value.autoSubmit;
});

document.querySelector("#save").addEventListener("click", async () => {
  await browser.storage.local.set({ apiUrl: apiUrl.value, token: token.value, autoSubmit: autoSubmit.checked });
  status.textContent = " 保存しました";
});
