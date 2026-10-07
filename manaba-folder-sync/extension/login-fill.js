// This code deliberately never stores or logs credentials. It asks the local
// native host for them only on an actual TID/Microsoft login page.
const NATIVE_HOST = "jp.ac.tid.manaba_folder_sync";

function setReactInput(input, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function fields() {
  const password = document.querySelector('input[type="password"]');
  const username = document.querySelector(
    'input[type="email"], input[name="loginfmt"], input[name="username"], input[autocomplete="username"], input[type="text"]'
  );
  return { username, password };
}

let credentialsPromise;
let pending = false;

function credentials() {
  credentialsPromise ??= browser.runtime.sendNativeMessage(NATIVE_HOST, { action: "credentials" });
  return credentialsPromise;
}

async function fill() {
  const { username, password } = fields();
  if (!username && !password) return;
  const values = await credentials();
  if (!values.ok) return;
  if (username && !username.value) setReactInput(username, values.username);
  if (password && !password.value) setReactInput(password, values.password);
  const { autoSubmit = false } = await browser.storage.local.get({ autoSubmit: false });
  if (autoSubmit && password && password.value) {
    const submit = document.querySelector('input[type="submit"], button[type="submit"], button[data-report-event="Signin_Submit"]');
    if (submit) submit.click();
  }
}

function scheduleFill() {
  if (pending) return;
  pending = true;
  queueMicrotask(() => {
    pending = false;
    fill().catch(() => {});
  });
}

// Azure replaces the username page with the password page without a reload.
const observer = new MutationObserver(scheduleFill);
observer.observe(document.documentElement, { childList: true, subtree: true });
scheduleFill();
