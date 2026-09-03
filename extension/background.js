// background service worker：代理 content script 的跨域图片下载请求
// （content script 的 fetch 受页面 CORS 限制，background 有 host_permissions 不受限）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'gmxhr') {
    const url = msg.opts && msg.opts.url;
    const method = (msg.opts && msg.opts.method) || 'GET';
    if (!url) { sendResponse({ error: '缺少 url' }); return false; }
    fetch(url, { method })
      .then(async (r) => {
        const buf = await r.arrayBuffer();
        // 转成普通数组确保可序列化通过 sendMessage
        sendResponse({ status: r.status, data: Array.from(new Uint8Array(buf)), error: null });
      })
      .catch((e) => sendResponse({ error: (e && e.message) || String(e) }));
    return true; // 异步响应
  }
  return false;
});
