const extensionApi = typeof browser !== 'undefined' ? browser : chrome;
const actionApi = extensionApi.action || extensionApi.browserAction;

actionApi.onClicked.addListener(() => {
  const url = extensionApi.runtime.getURL('popup.html');
  extensionApi.tabs.create({ url });
});
