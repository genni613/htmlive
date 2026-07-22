(() => {
  "use strict";

  const token = new URLSearchParams(location.search).get("token");
  const button = document.getElementById("export");
  const status = document.getElementById("status");
  let pageDraftStore = null;

  function setStatus(message, error = false) {
    status.textContent = message;
    status.classList.toggle("error", error);
  }

  function message(payload) {
    return new Promise((resolve) => chrome.runtime.sendMessage(payload, resolve));
  }

  async function loadDrafts() {
    if (!token) throw new Error("缺少导出记录");
    const response = await message({ type: "htmlive-read-local-export", token });
    if (!response || !response.ok || !response.pageDraftStore) throw new Error((response && response.error) || "导出记录已失效，请回到页面重试");
    pageDraftStore = response.pageDraftStore;
  }

  button.addEventListener("click", async () => {
    if (!pageDraftStore) return;
    let rootHandle;
    try {
      rootHandle = await window.showDirectoryPicker({ mode: "read", id: "htmlive-site-export" });
    } catch (error) {
      if (!(error && error.name === "AbortError")) setStatus("无法读取该文件夹", true);
      return;
    }

    button.disabled = true;
    setStatus("正在读取并打包文件…");
    try {
      const localFiles = await readDirectory(rootHandle);
      if (!localFiles.length) throw new Error("所选文件夹为空");
      const files = await Promise.all(localFiles.map(async ({ path, file }) => {
        if (!/\.x?html?$/i.test(path)) return { name: path, content: new Uint8Array(await file.arrayBuffer()) };
        const doc = new DOMParser().parseFromString(await file.text(), "text/html");
        const saved = draftForPath(path, rootHandle.name);
        for (const group of (saved && saved.groups) || []) {
          for (const patch of group.patches || []) applyPatch(doc, patch);
        }
        return { name: path, content: serializeDocument(doc) };
      }));

      const bytes = createStoredZip(files);
      const response = await message({
        type: "htmlive-download",
        fileName: `${safeName(rootHandle.name || "htmlive-site")}-edited-site.zip`,
        mimeType: "application/zip",
        base64: bytesToBase64(bytes),
      });
      if (!response || !response.ok) throw new Error((response && response.error) || "无法启动下载");
      const pageCount = files.filter((file) => /\.x?html?$/i.test(file.name)).length;
      setStatus(`已启动下载：${pageCount} 页和 ${files.length - pageCount} 个资源`);
      await message({ type: "htmlive-clear-local-export", token });
    } catch (error) {
      console.error("HTMLive local export failed", error);
      setStatus(`导出失败：${error.message || "未知错误"}`, true);
      button.disabled = false;
    }
  });

  async function readDirectory(root) {
    const files = [];
    async function visit(directory, prefix) {
      for await (const [name, handle] of directory.entries()) {
        const path = `${prefix}${name}`;
        if (handle.kind === "directory") await visit(handle, `${path}/`);
        else if (handle.kind === "file") files.push({ path, file: await handle.getFile() });
      }
    }
    await visit(root, "");
    return files;
  }

  function draftForPath(relativePath, rootName) {
    const encodedRoot = encodeURIComponent(rootName || "");
    const encodedPath = relativePath.split("/").map((part) => encodeURIComponent(part)).join("/");
    const suffix = `/${encodedRoot}/${encodedPath}`;
    const pages = pageDraftStore.pages || {};
    const pageKey = Object.keys(pages).find((key) => key.endsWith(suffix));
    return pageKey ? pages[pageKey] : null;
  }

  function applyPatch(doc, patch) {
    let node;
    try { node = doc.querySelector(patch.pageSelector); } catch (_) { return; }
    if (!node) return;
    for (const operation of patch.operations || []) {
      if (operation.type === "style") {
        for (const [name, value] of Object.entries(operation.style || {})) {
          if (value === null) node.style.removeProperty(name);
          else node.style.setProperty(name, value);
        }
      } else if (operation.type === "attr") {
        for (const [name, value] of Object.entries(operation.attributes || {})) {
          if (value === null) node.removeAttribute(name);
          else node.setAttribute(name, value);
        }
      } else if (operation.type === "html") {
        node.innerHTML = operation.html;
      } else if (operation.type === "remove") {
        node.remove();
      } else if (operation.type === "move") {
        let target;
        try { target = doc.querySelector(operation.targetSelector); } catch (_) { target = null; }
        if (target && target.parentElement) target.parentElement.insertBefore(node, operation.position === "before" ? target : target.nextSibling);
      }
    }
  }

  function serializeDocument(doc) {
    const doctype = doc.doctype ? `<!DOCTYPE ${doc.doctype.name}>` : "<!doctype html>";
    return `${doctype}\n${doc.documentElement.outerHTML}`;
  }

  function safeName(name) { return name.replace(/[\\/:*?"<>|]/g, "-"); }

  function bytesToBase64(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return btoa(binary);
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function createStoredZip(files) {
    const encoder = new TextEncoder();
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const file of files) {
      const name = encoder.encode(file.name);
      const content = file.content instanceof Uint8Array ? file.content : encoder.encode(file.content);
      const checksum = crc32(content);
      const local = new Uint8Array(30 + name.length + content.length);
      const view = new DataView(local.buffer);
      view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x0800, true);
      view.setUint16(10, dosTime, true); view.setUint16(12, dosDate, true); view.setUint32(14, checksum, true);
      view.setUint32(18, content.length, true); view.setUint32(22, content.length, true); view.setUint16(26, name.length, true);
      local.set(name, 30); local.set(content, 30 + name.length); locals.push(local);
      const central = new Uint8Array(46 + name.length);
      const centralView = new DataView(central.buffer);
      centralView.setUint32(0, 0x02014b50, true); centralView.setUint16(4, 20, true); centralView.setUint16(6, 20, true);
      centralView.setUint16(8, 0x0800, true); centralView.setUint16(12, dosTime, true); centralView.setUint16(14, dosDate, true);
      centralView.setUint32(16, checksum, true); centralView.setUint32(20, content.length, true); centralView.setUint32(24, content.length, true);
      centralView.setUint16(28, name.length, true); centralView.setUint32(42, offset, true); central.set(name, 46); centrals.push(central);
      offset += local.length;
    }
    const centralSize = centrals.reduce((total, part) => total + part.length, 0);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true); endView.setUint16(8, files.length, true); endView.setUint16(10, files.length, true);
    endView.setUint32(12, centralSize, true); endView.setUint32(16, offset, true);
    const parts = [...locals, ...centrals, end];
    const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let position = 0;
    for (const part of parts) { result.set(part, position); position += part.length; }
    return result;
  }

  loadDrafts().catch((error) => {
    setStatus(error.message || "无法准备导出", true);
    button.disabled = true;
  });
})();
