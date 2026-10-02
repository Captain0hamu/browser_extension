const extension = globalThis.browser ?? globalThis.chrome;

extension.action.onClicked.addListener(() => {
  extension.tabs.create({ url: extension.runtime.getURL("viewer.html") });
});
