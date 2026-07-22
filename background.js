// Fallback for Chrome's "When you click the extension" site-access mode.
// With access set to "On all sites", manifest content scripts inject automatically
// after every navigation; this handler lets a user open HTMLive immediately instead.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;

  try {
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ["assets/editor.css"],
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["assets/editor.js"],
    });
  } catch (error) {
    // Chrome blocks injection on its own internal pages. There is no user action to take there.
    console.debug("HTMLive could not be injected into this page.", error);
  }
});

const LOCAL_EXPORT_KEY = "htmlive-local-export:";

// Downloads initiated after a directory picker no longer have the original page
// click's user activation. Use Chrome's downloads API so local-site exports are
// not silently blocked after the user has selected a folder.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return;

  if (message.type === "htmlive-open-local-export") {
    const token = crypto.randomUUID();
    chrome.storage.session.set({ [LOCAL_EXPORT_KEY + token]: message.pageDraftStore }).then(
      () => chrome.windows.create({
        url: `${chrome.runtime.getURL("local-export.html")}?token=${encodeURIComponent(token)}`,
        type: "popup",
        width: 460,
        height: 330,
      }),
    ).then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: error && error.message ? error.message : "无法打开导出窗口" }),
    );
    return true;
  }

  if (message.type === "htmlive-read-local-export") {
    const key = LOCAL_EXPORT_KEY + message.token;
    chrome.storage.session.get(key).then(
      (data) => sendResponse({ ok: true, pageDraftStore: data[key] || null }),
      (error) => sendResponse({ ok: false, error: error && error.message ? error.message : "无法读取导出记录" }),
    );
    return true;
  }

  if (message.type === "htmlive-clear-local-export") {
    chrome.storage.session.remove(LOCAL_EXPORT_KEY + message.token).finally(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type !== "htmlive-download") return;

  chrome.downloads.download({
    url: `data:${message.mimeType || "application/octet-stream"};base64,${message.base64}`,
    filename: message.fileName,
    saveAs: true,
  }).then(
    () => sendResponse({ ok: true }),
    (error) => sendResponse({ ok: false, error: error && error.message ? error.message : "下载失败" }),
  );
  return true;
});
