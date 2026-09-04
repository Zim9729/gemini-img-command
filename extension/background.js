// background service worker：代理 content script 的跨域图片下载请求
// （content script 的 fetch 受页面 CORS 限制，background 有 host_permissions 不受限）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'gmxhr') {
    const url = msg.opts && msg.opts.url;
    const method = (msg.opts && msg.opts.method) || 'GET';
    if (!url) { sendResponse({ error: '缺少 url' }); return false; }
    // fetch 超时中止（AbortSignal.timeout 需 Chrome 103+；旧版本回退不限时，
    // 由 gm-shim 侧的定时器触发 ontimeout 兜底）
    const timeout = (typeof msg.opts.timeout === 'number' && msg.opts.timeout > 0) ? msg.opts.timeout : 60000;
    let signal = null;
    try { if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) signal = AbortSignal.timeout(timeout); } catch (e) {}
    fetch(url, { method, signal })
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
