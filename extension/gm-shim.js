/* ---- GM_* API shim（Chrome/Edge 扩展模式，不依赖 Tampermonkey） ----
 * GM_setValue / GM_getValue：同步，用 localStorage（脚本本身已有回退逻辑）
 * GM_registerMenuCommand：扩展无油猴菜单，空实现
 * GM_xmlhttpRequest：通过 background service worker 跨域 fetch
 * GM_info：提供脚本版本等元信息（runDiag 诊断用）
 */
const GM_setValue = (k, v) => { try { localStorage.setItem('gic-gm:' + k, String(v)); } catch (e) {} };
const GM_getValue  = (k, d) => { try { const v = localStorage.getItem('gic-gm:' + k); return v === null ? d : v; } catch (e) { return d; } };
const GM_registerMenuCommand = function () {};
const GM_info = { script: { version: '2.1.4', name: 'Gemini 批量图片生成面板' } };
const GM_xmlhttpRequest = (opts) => {
  chrome.runtime.sendMessage(
    { type: 'gmxhr', opts: { method: opts.method || 'GET', url: opts.url } },
    (resp) => {
      if (chrome.runtime.lastError || !resp) {
        if (opts.onerror) opts.onerror(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'background 无响应'));
        return;
      }
      if (resp.error) {
        if (opts.onerror) opts.onerror(new Error(resp.error));
        return;
      }
      if (opts.onload) opts.onload({ status: resp.status, response: new Blob([new Uint8Array(resp.data)]) });
    }
  );
};
