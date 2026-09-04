// ==UserScript==
// @name         Gemini 批量图片生成面板
// @namespace    gemini-img-command
// @version      2.1.3
// @description  gemini.google.com 批量图片生成配置面板：提前选好文件夹 + 填好提示词，点击「执行」自动循环每一张图（每图独立新对话）→ 等待生成 → 按原图文件名下载，直至全部完成。
// @author       gemini-img-command
// @match        https://gemini.google.com/*
// @run-at       document-start
// @noframes
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      googleusercontent.com
// @connect      google.com
// @connect      gstatic.com
// @connect      googleapis.com
// ==/UserScript==

/*
 * ────────────────────────────────────────────────────────────────
 *  Gemini 批量图片生成面板（配置界面模式）
 *
 *  使用方式（配置界面，无聊天命令）：
 *    1. 打开 gemini.google.com，点击右下角 🖼 圆形按钮（或按 Alt+G）打开面板
 *    2. 在面板中点击「选择文件夹」，选中存放待生成图片的文件夹（会被记住）
 *    3. 在「提示词」输入框填好提示词（自动保存，下次还在）
 *    4. 点击「▶ 执行」—— 自动循环每一张图，直至全部完成：
 *         每张图单独新开一个对话 → 自动上传 → 发送提示词 → 等待生成完成
 *         → 下载生成图，文件名与原图完全一致
 *
 *  说明：受浏览器安全限制，无法直接输入本地路径文本，文件夹通过
 *  系统选择框指定一次即可，脚本会持久化记住（执行时无需再选）。
 * ────────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  /* ---- 版本标识与加载横幅（F12 控制台过滤 gic 即可确认脚本是否在运行） ---- */
  const SCRIPT_VERSION = '2.1.3';
  try {
    console.log('%c[gic] Gemini 批量图片生成面板 v' + SCRIPT_VERSION + ' 已加载',
      'color:#8ab4f8;font-weight:bold');
    console.log('[gic] 若页面右下角未出现 🖼 悬浮按钮，请检查 Tampermonkey 是否已启用本脚本（且版本为 ' + SCRIPT_VERSION + '），然后刷新页面');
  } catch (e) {}

  /* ============================================================
   * 一、配置
   * ============================================================ */
  const DEFAULT_CFG = {
    defaultPrompt: '',             // 面板中的提示词（自动保存）
    newChatPerImage: true,         // 每张图新开一个对话
    exactName: true,               // 严格使用原文件名（不做扩展名纠正）
    waitTimeoutMs: 300 * 1000,     // 单张图等待生成的超时（5 分钟）
    uploadTimeoutMs: 120 * 1000,   // 等待附件上传完成的超时（2 分钟）
    minImgSize: 200,               // 判定为「生成图」的最小宽度(px)
  };

  function safeParse(s) {
    try { return JSON.parse(s) || {}; } catch (e) { return {}; }
  }
  // GM_* 不可用（如 Greasemonkey 4 只提供异步 GM.*）时回退到 localStorage，避免脚本在此处直接中止
  const gm = {
    get(k, d) {
      try { return GM_getValue(k, d); } catch (e) {
        try { const v = localStorage.getItem('gic-gm:' + k); return v === null ? d : v; } catch (_) { return d; }
      }
    },
    set(k, v) {
      try { GM_setValue(k, v); } catch (e) {
        try { localStorage.setItem('gic-gm:' + k, v); } catch (_) {}
      }
    }
  };
  let cfg = Object.assign({}, DEFAULT_CFG, safeParse(gm.get('cfg', '{}')));
  function saveCfg() { gm.set('cfg', JSON.stringify(cfg)); }

  /* ============================================================
   * 二、基础工具
   * ============================================================ */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

  // 取消标志：stopQueue 设为 true 后，所有 waitFor 轮询会立即返回 null，使长操作秒级中断
  let cancelRequested = false;

  function waitFor(fn, timeout, step) {
    step = step || 500;
    return new Promise((resolve) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        if (cancelRequested) { clearInterval(timer); resolve(null); return; }
        let v = null;
        try { v = fn(); } catch (e) { v = null; }
        if (v) { clearInterval(timer); resolve(v); }
        else if (Date.now() - t0 >= timeout) { clearInterval(timer); resolve(null); }
      }, step);
    });
  }

  function toast(msg, ms) {
    try {
      const host = document.body || document.documentElement;
      const d = document.createElement('div');
      d.textContent = msg;
      d.style.cssText = [
        'position:fixed', 'top:18px', 'left:50%', 'transform:translateX(-50%)',
        'z-index:2147483647', 'background:#1e1f22', 'color:#e3e3e3',
        'padding:10px 18px', 'border-radius:8px', 'border:1px solid #3c4043',
        'box-shadow:0 4px 16px rgba(0,0,0,.4)', 'font:13px/1.5 system-ui,sans-serif',
        'max-width:80vw', 'word-break:break-all'
      ].join(';');
      host.appendChild(d);
      setTimeout(() => {
        d.style.transition = 'opacity .4s';
        d.style.opacity = '0';
        setTimeout(() => d.remove(), 450);
      }, ms || 3500);
    } catch (e) { /* 忽略 */ }
  }

  /* ============================================================
   * 三、队列持久化（localStorage 存元信息 + IndexedDB 存图片文件）
   * ============================================================ */
  const META_KEY = 'gic-queue';

  function metaLoad() {
    try { return JSON.parse(localStorage.getItem(META_KEY) || 'null'); } catch (e) { return null; }
  }
  function metaSave(m) {
    try { localStorage.setItem(META_KEY, JSON.stringify(m)); } catch (e) {}
  }

  const DB_NAME = 'gemini-img-cmd';
  const STORE = 'kv';

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { try { req.result.createObjectStore(STORE); } catch (e) {} };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function idbOp(key, mode, op) {
    return idbOpen().then((db) => new Promise((resolve, reject) => {
      let rq = null;
      try {
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        rq = op(store);
        tx.oncomplete = () => { db.close(); resolve(rq ? rq.result : undefined); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      } catch (e) {
        try { db.close(); } catch (_) {}
        reject(e);
      }
    }));
  }

  const fileSet = (i, f) => idbOp('file:' + i, 'readwrite', (s) => s.put(f, 'file:' + i));
  const fileGet = (i) => idbOp('file:' + i, 'readonly', (s) => s.get('file:' + i)).catch(() => null);
  const fileDel = (i) => idbOp('file:' + i, 'readwrite', (s) => s.delete('file:' + i)).catch(() => {});

  // 记住上次的文件夹句柄（Chrome/Edge 支持把 FileSystemDirectoryHandle 存入 IndexedDB）
  const HANDLE_KEY = 'dirHandle';
  const saveDirHandle = (h) => idbOp(HANDLE_KEY, 'readwrite', (s) => s.put(h, HANDLE_KEY)).catch(() => {});
  const loadDirHandle = () => idbOp(HANDLE_KEY, 'readonly', (s) => s.get(HANDLE_KEY)).catch(() => null);

  /* ---- 多标签页互斥锁（localStorage，心跳保活） ---- */
  const TAB_ID = Math.random().toString(36).slice(2);

  function lockInfo() {
    try { return JSON.parse(localStorage.getItem('gic-lock') || 'null'); } catch (e) { return null; }
  }
  function tryAcquireLock() {
    const lk = lockInfo();
    if (lk && lk.tab !== TAB_ID && Date.now() - lk.ts < 15000) return false;
    heartbeat();
    return true;
  }
  function heartbeat() {
    try { localStorage.setItem('gic-lock', JSON.stringify({ tab: TAB_ID, ts: Date.now() })); } catch (e) {}
  }
  function releaseLock() {
    const lk = lockInfo();
    if (lk && lk.tab === TAB_ID) {
      try { localStorage.removeItem('gic-lock'); } catch (e) {}
    }
  }

  /* ============================================================
   * 四、页面 DOM 定位（多层选择器 + 兜底）
   * ============================================================ */
  const isVisible = (el) => !!el && el.getClientRects().length > 0;

  const EDITOR_SELS = [
    'rich-textarea .ql-editor',                                  // Quill 编辑器（Gemini 输入框）
    '.ql-editor',
    'rich-textarea [contenteditable="true"]',
    'main [contenteditable="true"][role="textbox"]',
    'form [contenteditable="true"]',
    '#editor [contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]'
  ];

  function getEditor() {
    // 只取可见的；页面上可能同时存在隐藏的编辑器实例，主输入框通常在最下方
    for (const sel of EDITOR_SELS) {
      const list = [...document.querySelectorAll(sel)].filter(isVisible);
      if (list.length) return list[list.length - 1];
    }
    return null;
  }

  function composerRoot() {
    const ed = getEditor();
    if (!ed) return null;
    // Gemini 的附件预览、发送按钮与 rich-textarea 是兄弟节点，需向上找到整个输入区组件
    return ed.closest('input-container, input-area-v2, .input-area-container, form, .chat-input-container, .input-area')
      || (ed.parentElement && ed.parentElement.parentElement)
      || null;
  }

  function inComposer(el) {
    const root = composerRoot();
    return !!(root && (root === el || root.contains(el)));
  }

  function findSendButton() {
    const roots = [];
    const cr = composerRoot();
    if (cr) roots.push(cr);
    roots.push(document);
    const sels = [
      'button[aria-label*="发送"]', 'button[aria-label*="Send"]',
      'button.send-button', 'button[data-test-id*="send"]',
      'button[mattooltip*="发送"]', 'button[mattooltip*="Send"]'
    ];
    for (const root of roots) {
      for (const sel of sels) {
        const list = [...root.querySelectorAll(sel)].filter((b) => !b.disabled && b.getClientRects().length);
        if (list.length) return list[list.length - 1];
      }
      // 图标名兜底（Material 图标 send / arrow_upward）
      const icons = [...root.querySelectorAll('button mat-icon, button .material-symbols-outlined, button [fonticon]')];
      for (const ic of icons) {
        const name = (ic.textContent || ic.getAttribute('fonticon') || '').trim().toLowerCase();
        if (name === 'send' || name === 'arrow_upward') {
          const b = ic.closest('button');
          if (b && !b.disabled && b.getClientRects().length) return b;
        }
      }
    }
    return null;
  }

  function findStopButton() {
    const roots = [];
    const cr = composerRoot();
    if (cr) roots.push(cr);
    roots.push(document);
    const sels = [
      'button[aria-label*="停止"]', 'button[aria-label*="Stop"]',
      'button[mattooltip*="停止"]', 'button[mattooltip*="Stop"]'
    ];
    for (const root of roots) {
      for (const sel of sels) {
        const b = root.querySelector(sel);
        if (b && b.getClientRects().length) return b;
      }
      const icons = [...root.querySelectorAll('button mat-icon, button [fonticon]')];
      for (const ic of icons) {
        const name = (ic.textContent || ic.getAttribute('fonticon') || '').trim().toLowerCase();
        if (name === 'stop' || name === 'stop_circle') {
          const b = ic.closest('button');
          if (b && b.getClientRects().length) return b;
        }
      }
    }
    return null;
  }

  function tryFindNewChatButton() {
    // 优先：Gemini 侧栏的新对话组件（data-test-id）
    const direct = [...document.querySelectorAll(
      '[data-test-id*="new-chat"] button, button[data-test-id*="new-chat"], [data-test-id*="new-chat"], a[href="/app"]'
    )].filter(isVisible);
    if (direct.length) return direct[0];
    // 兜底：按文案匹配（新对话 / 发起新对话 / 新聊天 / New chat / New conversation）
    const pats = [/新(对话|聊天|会话)/, /new (chat|conversation)/i];
    const els = [...document.querySelectorAll('button, a, [role="button"], mat-list-item')];
    for (const el of els) {
      const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('mattooltip') || '') + ' ' + (el.textContent || '')).trim();
      if (!label || label.length > 40) continue;
      if (pats.some((p) => p.test(label)) && isVisible(el)) return el;
    }
    return null;
  }

  const isFreshChat = () => !!getEditor() && (/^\/app\/?$/.test(location.pathname) || countResponses() === 0);

  // 不做整页刷新：按钮 → SPA 路由软跳转 → 都失败则返回 false，由调用方决定是否在当前对话继续
  async function tryStartNewChat() {
    if (isFreshChat()) return true;
    const b = tryFindNewChatButton();
    if (b) {
      b.click();
      if (await waitFor(isFreshChat, 12000, 500)) return true;
    }
    try {
      history.pushState({}, '', '/app');
      window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
      if (await waitFor(isFreshChat, 8000, 500)) return true;
    } catch (e) { /* 忽略 */ }
    return false;
  }

  /* ---- 回复定位与生成图识别 ---- */
  const RESP_SELS = 'model-response, .response-container, [data-test-id="model-response"], .model-response-text';

  function countResponses() { return document.querySelectorAll(RESP_SELS).length; }

  function isGeneratedImg(im) {
    if (!im.complete || !im.naturalWidth) return false;
    if (im.closest('user-query, .query-content, [data-test-id*="query"]')) return false; // 排除用户消息里的原图
    if (inComposer(im)) return false;                                                      // 排除输入框预览
    return im.naturalWidth >= cfg.minImgSize;
  }

  function collectResponseImages() {
    const list = [...document.querySelectorAll(RESP_SELS)];
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i];
      if (c.closest('user-query, .query-content, [data-test-id*="query"]')) continue;
      const imgs = [...c.querySelectorAll('img')].filter(isGeneratedImg);
      if (imgs.length) return imgs;
    }
    return [];
  }

  /* ============================================================
   * 五、动作：输入、上传、发送、等待
   * ============================================================ */
  // 用 Selection API 全选编辑器内容（比 execCommand('selectAll') 可靠：后者在焦点不在编辑器内时会选中整页）
  function selectAllIn(ed) {
    ed.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(ed);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // 移除输入区里残留的附件（上一张失败后留下的图片 chip），避免下一张叠加成两张
  async function clearAttachments() {
    const root = composerRoot();
    if (!root) return;
    const sels = [
      'button[aria-label*="移除"]', 'button[aria-label*="删除"]', 'button[aria-label*="Remove"]', 'button[aria-label*="Delete"]',
      'button[mattooltip*="移除"]', 'button[mattooltip*="Remove"]'
    ];
    for (let n = 0; n < 5; n++) {
      const b = sels.map((s) => [...root.querySelectorAll(s)].filter(isVisible)[0]).find(Boolean);
      if (!b) break;
      b.click();
      await sleep(300);
    }
  }

  async function clearEditor() {
    await clearAttachments();
    const ed = getEditor();
    if (!ed) return;
    try {
      selectAllIn(ed);
      document.execCommand('delete', false, null);
    } catch (e) { /* 忽略 */ }
    await sleep(200);
  }

  const normWs = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  function editorHasText(text) {
    const ed = getEditor();
    if (!ed) return false;
    const want = normWs(text).slice(0, 12);
    return !!want && normWs(ed.innerText || ed.textContent).includes(want);
  }

  // 三级兜底：execCommand → 模拟粘贴纯文本 → 直接写 DOM（Quill 有 MutationObserver 会同步）
  async function setPrompt(text) {
    const strategies = [
      ['execCommand', (ed) => {
        selectAllIn(ed);
        document.execCommand('insertText', false, text);
      }],
      ['paste', (ed) => {
        selectAllIn(ed);
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        ed.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
      }],
      ['dom', (ed) => {
        ed.focus();
        ed.textContent = '';
        const p = document.createElement('p');
        p.textContent = text;
        ed.appendChild(p);
        ed.classList.remove('ql-blank');
        ed.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        // 光标放到末尾，便于后续操作
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(p);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }]
    ];
    for (const [name, fn] of strategies) {
      const ed = getEditor();
      if (!ed) throw new Error('找不到输入框');
      try { fn(ed); } catch (e) { log('  ⚠ 输入提示词（' + name + '）异常：' + ((e && e.message) || e)); }
      await sleep(500);
      if (editorHasText(text)) {
        if (name !== 'execCommand') log('  ⌨ 提示词已填入（' + name + ' 方式）');
        return;
      }
    }
    throw new Error('无法输入提示词（三种方式均失败，请点「诊断」并反馈）');
  }

  function uploadViaPaste(file) {
    const ed = getEditor();
    if (!ed) return false;
    try {
      ed.focus();
      const dt = new DataTransfer();
      dt.items.add(file);
      const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
      // 注意：dispatchEvent 在页面 preventDefault（= Gemini 已接管粘贴）时返回 false，
      // 所以不能用返回值判断成败，只要派发没抛异常就算「已尝试」，成败交给 attached() 检测
      ed.dispatchEvent(ev);
      return true;
    } catch (e) { return false; }
  }

  // 附件预览：Gemini 的本地预览图是 blob:/data: 地址（生成图是 https://lh3…，不会混淆）
  const PREVIEW_SEL = 'uploader-file-preview, uploader-file-preview-container, [data-test-id*="file-preview"], [data-test-id*="uploaded"], .file-preview, img[src^="blob:"], img[src^="data:image"]';
  const inResponseArea = (el) => !!el.closest(RESP_SELS + ', user-query, .query-content');

  async function uploadSettle() {
    // 等上传进度指示消失（只看非回复区域；选择器不匹配时直接放行，不作为失败条件）
    await waitFor(() => ![...document.querySelectorAll('mat-progress-spinner, mat-spinner, mat-progress-bar, [role="progressbar"]')]
      .some((p) => isVisible(p) && !inResponseArea(p)), cfg.uploadTimeoutMs, 800);
    await sleep(1500);
  }

  async function uploadFile(file) {
    const nameKey = (file.name.replace(/\.[^.]+$/, '') || file.name).slice(0, 8);
    const before = new Set(document.querySelectorAll(PREVIEW_SEL));
    const attached = () => {
      const r = composerRoot();
      if (r && (r.textContent || '').includes(nameKey)) return true;                 // 出现文件名 chip
      return [...document.querySelectorAll(PREVIEW_SEL)]                              // 或出现新的预览元素
        .some((el) => !before.has(el) && isVisible(el) && !inResponseArea(el) && !panelEl?.contains(el));
    };

    // 途径 1：向编辑器模拟「粘贴」（Gemini 会接管 paste 事件并附加文件）
    if (uploadViaPaste(file) && await waitFor(attached, 12000, 500)) {
      await uploadSettle();
      log('  ⬆ 已附加（粘贴方式）：' + file.name);
      return;
    }

    // 途径 2：页面上已存在的 file input（优先 accept 含 image 的）
    const inputs = [...document.querySelectorAll('input[type="file"]')]
      .sort((a, b) => ((b.accept || '').includes('image') ? 1 : 0) - ((a.accept || '').includes('image') ? 1 : 0))
      .slice(0, 3);
    for (const inp of inputs) {
      try {
        const dt = new DataTransfer();
        dt.items.add(file);
        inp.files = dt.files;
        inp.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      } catch (e) { continue; }
      if (await waitFor(attached, 8000, 500)) {
        await uploadSettle();
        log('  ⬆ 已附加：' + file.name);
        return;
      }
    }

    throw new Error('无法把图片放入输入框（粘贴与 file input 均未检测到附件预览，请点「诊断」反馈）');
  }

  async function sendAndWait() {
    const prevCount = countResponses();
    const btn = await waitFor(findSendButton, 20000, 400);
    if (!btn) throw new Error('找不到发送按钮');
    btn.click();
    log('  ✉ 已发送，等待生成…');

    const started = await waitFor(() =>
      countResponses() > prevCount || !!findStopButton() || !findSendButton()
    , 60000, 700);
    if (!started) throw new Error('发送后未检测到新回复');

    await sleep(3000); // 等待界面切换到「生成中」状态，避免误判
    const done = await waitFor(() => !!findSendButton() && !findStopButton(), cfg.waitTimeoutMs, 1000);
    if (!done) throw new Error('等待生成超时');

    await sleep(2500); // 图片渲染稳定
    let imgs = collectResponseImages();
    if (!imgs.length) {
      imgs = (await waitFor(() => {
        const v = collectResponseImages();
        return v.length ? v : null;
      }, 30000, 1500)) || [];
    }
    if (!imgs.length) throw new Error('回复中没有生成图片（可能被拒绝或纯文字回复）');
    return imgs;
  }

  /* ============================================================
   * 六、下载与命名
   * ============================================================ */
  function splitName(name) {
    const m = String(name).match(/^(.*?)(?:\.([A-Za-z0-9]{1,5}))?$/);
    return { base: m[1] || 'gemini-image', ext: (m[2] || 'png').toLowerCase() };
  }

  function blobExt(blob) {
    const t = (blob.type || '').toLowerCase();
    if (t.includes('png')) return 'png';
    if (t.includes('jpeg') || t.includes('jpg')) return 'jpg';
    if (t.includes('webp')) return 'webp';
    if (t.includes('gif')) return 'gif';
    return null;
  }

  const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

  function gmFetchBlob(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        responseType: 'blob',
        onload: (r) => (r.status >= 200 && r.status < 300) ? resolve(r.response) : reject(new Error('HTTP ' + r.status)),
        onerror: () => reject(new Error('网络或跨域受限'))
      });
    });
  }

  // 把可绘制对象（<img> 或 ImageBitmap）导出为指定格式的 Blob
  function drawToBlob(source, w, h, ext) {
    return new Promise((resolve, reject) => {
      try {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(source, 0, 0);
        c.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas 导出为空'))), MIME_BY_EXT[ext] || 'image/png', 0.95);
      } catch (e) { reject(new Error('canvas 读取失败（' + ((e && e.name) || e) + '）')); }
    });
  }

  // 取生成图数据。Gemini 常把生成图渲染为 blob: 地址并在加载后 revoke，此时 fetch 会 "Failed to fetch"，
  // 但 <img> 仍持有像素，可直接画到 canvas 导出（同源 blob:/data: 不会污染 canvas）
  async function fetchImageBlob(img, ext) {
    const src = img.currentSrc || img.src || '';
    if (!src) throw new Error('图片地址为空');
    const errors = [];
    const isLocal = src.startsWith('blob:') || src.startsWith('data:') || src.startsWith(location.origin + '/');
    if (isLocal) {
      try {
        const r = await fetch(src);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.blob();
      } catch (e) { errors.push('fetch：' + ((e && e.message) || e)); }
    } else {
      try { return await gmFetchBlob(src); } catch (e) { errors.push('GM_xhr：' + ((e && e.message) || e)); }
    }
    try {
      const b = await drawToBlob(img, img.naturalWidth, img.naturalHeight, ext);
      log('  🖌 已从页面图像元素直接导出（' + img.naturalWidth + '×' + img.naturalHeight + '）');
      return b;
    } catch (e) { errors.push((e && e.message) || String(e)); }
    throw new Error('下载图片失败：' + errors.join('；'));
  }

  // 已拿到的图片数据重编码为目标扩展名对应的格式（保证「原文件名 .jpg」里装的确实是 JPEG）
  async function convertBlob(blob, ext) {
    if (!MIME_BY_EXT[ext]) return blob;
    const bm = await createImageBitmap(blob);
    try { return await drawToBlob(bm, bm.width, bm.height, ext); } finally { bm.close(); }
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    (document.body || document.documentElement).appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function downloadImages(imgs, origName) {
    const p = splitName(origName);
    for (let i = 0; i < imgs.length; i++) {
      const suffix = imgs.length > 1 ? (i === 0 ? '' : '_' + (i + 1)) : '';
      let blob = await fetchImageBlob(imgs[i], p.ext);
      if (!blob || blob.size < 1024) throw new Error('下载的图片数据异常');
      const realExt = blobExt(blob);
      let useExt = p.ext;
      if (realExt && realExt !== p.ext && realExt !== 'gif') {
        if (cfg.exactName) {
          // 严格原文件名：把数据转成扩展名对应的格式，而不是把 PNG 数据存成 .jpg
          try { blob = await convertBlob(blob, p.ext); log('  🔁 已将 ' + realExt.toUpperCase() + ' 转为 ' + p.ext.toUpperCase()); }
          catch (e) { log('  ⚠ 格式转换失败，按原始 ' + realExt.toUpperCase() + ' 数据保存为 .' + p.ext); }
        } else {
          useExt = realExt;
        }
      }
      const filename = p.base + suffix + '.' + useExt;
      saveBlob(blob, filename);
      log('  💾 已下载：' + filename);
      await sleep(1000); // 避免浏览器下载节流
    }
  }

  /* ============================================================
   * 七、队列调度（循环每一张图，直至全部完成）
   * ============================================================ */
  let localRunning = false;

  async function startRun(files, prompt) {
    const old = metaLoad();
    if (old && !old.done && !old.stopped) {
      toast('已有队列在执行中（点「停止」可终止）');
      return;
    }
    const names = files.map((f) => f.name);
    const meta = {
      prompt: String(prompt).trim(),
      names: names,
      statuses: names.map(() => 'pending'),
      errors: {},
      idx: 0,
      done: false
    };
    metaSave(meta);
    for (let i = 0; i < files.length; i++) await fileSet(i, files[i]);
    log('🚀 新任务：' + names.length + ' 张图片，提示词：' + meta.prompt);
    updatePanelState();
    processQueue();
  }

  async function processOne(i, prompt, name) {
    const file = await fileGet(i);
    if (!file) throw new Error('文件数据丢失，请重新发起任务');
    await clearEditor();
    await uploadFile(file);
    await setPrompt(prompt);
    const imgs = await sendAndWait();
    await downloadImages(imgs, name);
  }

  async function processQueue() {
    if (localRunning) return;
    const m = metaLoad();
    if (!m || m.done || m.stopped) return;
    if (!tryAcquireLock()) { log('⏸ 其他标签页正在处理队列'); return; }
    localRunning = true;
    cancelRequested = false;
    const hb = setInterval(heartbeat, 5000);
    try {
      panelShow();
      renderList(m);
      const ready = await waitFor(() => !!getEditor() && !!composerRoot(), 45000, 600);
      if (!ready) { log('⚠ 页面输入框未就绪；刷新页面后会自动续跑'); return; }

      for (let i = m.idx; i < m.names.length; i++) {
        const cur = metaLoad();
        if (!cur || cur.done || cur.stopped) { log('⏹ 队列已被停止'); return; }
        if (m.statuses[i] === 'ok' || m.statuses[i] === 'err') continue;

        panelSetState(m, i, 'busy');
        log('▶ [' + (i + 1) + '/' + m.names.length + '] ' + m.names[i]);
        try {
          if (cfg.newChatPerImage) {
            log('  ↗ 新开对话…');
            if (!(await tryStartNewChat())) log('  ⚠ 无法进入新对话（未找到按钮），本张在当前对话中继续');
            // 新对话切换后编辑器会重建，等它就绪
            if (!(await waitFor(() => !!getEditor() && !!composerRoot(), 15000, 500))) throw new Error('新对话页面输入框未就绪');
          }
          await processOne(i, m.prompt, m.names[i]);
          m.statuses[i] = 'ok';
          panelSetState(m, i, 'ok');
          log('✅ ' + m.names[i]);
        } catch (e) {
          // 被用户停止时，当前图片回退为 pending（不标记为错误），以便续跑
          if (cancelRequested) {
            m.statuses[i] = 'pending';
            m.stopped = true; // stopQueue 已写 stopped=true，但 m 是循环开始时加载的快照，需补上再保存
            metaSave(m);
            log('⏹ 已停止，当前图片未完成（点「执行」可继续）');
            return;
          }
          m.statuses[i] = 'err';
          m.errors = m.errors || {};
          m.errors[i] = String((e && e.message) || e);
          panelSetState(m, i, 'err');
          log('❌ ' + m.names[i] + '：' + m.errors[i]);
        }
        m.idx = i + 1;
        // stopQueue 可能在 processOne 的不可中断段（如 downloadImages）期间写入 stopped=true，
        // m 是循环开始时的快照不含该字段，保存前需同步，否则会覆盖 stopped 导致队列不停止
        if (cancelRequested) m.stopped = true;
        metaSave(m);
        await fileDel(i);
        await sleep(1200);
      }

      const okN = m.statuses.filter((s) => s === 'ok').length;
      const errN = m.statuses.filter((s) => s === 'err').length;
      m.done = true;
      metaSave(m);
      log('🎉 队列完成：成功 ' + okN + '，失败 ' + errN);
      toast('全部处理完成：成功 ' + okN + '，失败 ' + errN, 5000);
    } finally {
      clearInterval(hb);
      localRunning = false;
      cancelRequested = false;
      releaseLock();
      updatePanelState();
    }
  }

  function stopQueue() {
    const q = metaLoad();
    if (q && !q.done && !q.stopped) {
      q.stopped = true;
      metaSave(q);
      cancelRequested = true; // 让正在执行的 waitFor 秒级返回 null
      releaseLock();
      renderList(q);
      updatePanelState();
      toast('已停止（点「执行」可从停止处继续）');
    } else {
      toast('当前没有执行中的队列');
    }
  }

  /* ============================================================
   * 八、文件夹/图片选择（三层兜底：原生API → input控件 → 页面内按钮）
   * ============================================================ */
  function isImageName(name) {
    if (!name || name.startsWith('.')) return false;
    const m = String(name).match(/\.([A-Za-z0-9]+)$/);
    return !!m && ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'].indexOf(m[1].toLowerCase()) >= 0;
  }

  function isImageFile(f) {
    if (!f || !f.name || f.name.startsWith('.')) return false;
    return isImageName(f.name) || !!(f.type && f.type.indexOf('image/') === 0);
  }

  async function walkDir(dir, prefix, out) {
    for await (const entry of dir.values()) {
      try {
        if (entry.kind === 'directory') {
          await walkDir(entry, prefix + entry.name + '/', out);
        } else if (entry.kind === 'file' && isImageName(entry.name)) {
          const f = await entry.getFile();
          if (isImageFile(f)) out.push({ file: f, path: prefix + entry.name });
        }
      } catch (e) { /* 单个文件读取失败，跳过 */ }
    }
  }

  function pickerViaInput(folder) {
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      if (folder) {
        try { inp.webkitdirectory = true; } catch (e) {}
        try { inp.setAttribute('webkitdirectory', ''); } catch (e) {}
        try { inp.setAttribute('directory', ''); } catch (e) {}
      } else {
        inp.multiple = true;
        inp.accept = 'image/*';
      }
      inp.style.cssText = 'position:fixed;left:-9999px;top:0;';
      (document.body || document.documentElement).appendChild(inp);

      let done = false, blurred = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        clearTimeout(blockTimer);
        clearInterval(focusPoll);
        window.removeEventListener('blur', onBlur);
        try { inp.remove(); } catch (e) {}
        resolve(v);
      };
      const onBlur = () => { blurred = true; };
      window.addEventListener('blur', onBlur);
      // 2.5 秒内既未弹窗（无 blur）也未被取消 → 判定被浏览器拦截
      const blockTimer = setTimeout(() => { if (!done && !blurred) finish({ blocked: true }); }, 2500);
      // 对话框关闭后（焦点回来）若 800ms 内没有 change 事件，视为取消
      const focusPoll = setInterval(() => {
        if (done || !blurred) return;
        if (document.hasFocus()) setTimeout(() => { if (!done) finish({ files: [] }); }, 800);
      }, 500);

      inp.addEventListener('change', () => {
        const all = [...inp.files];
        const files = folder
          ? all.filter(isImageFile).sort((a, b) =>
              String(a.webkitRelativePath || a.name).localeCompare(String(b.webkitRelativePath || b.name), 'zh-CN'))
          : all;
        finish({ files: files, paths: files.map((f) => f.webkitRelativePath || f.name) });
      }, { once: true });
      inp.addEventListener('cancel', () => finish({ files: [] }), { once: true });
      inp.click();
    });
  }

  function pickerViaButton(folder) {
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center';
      const box = document.createElement('div');
      box.style.cssText = 'background:#1e1f22;color:#e3e3e3;border:1px solid #3c4043;border-radius:12px;padding:22px 26px;max-width:420px;font:14px/1.7 system-ui,sans-serif;text-align:center';
      const title = document.createElement('div');
      title.style.cssText = 'font-weight:600;margin-bottom:6px';
      title.textContent = folder ? '选择文件夹' : '选择图片';
      const tip = document.createElement('div');
      tip.style.cssText = 'color:#9aa0a6;margin-bottom:16px';
      tip.textContent = '浏览器不允许脚本自动打开系统选择框，请点击下面的按钮：';
      const btn = document.createElement('button');
      btn.textContent = folder ? '📁 点击选择文件夹' : '🖼 点击选择图片';
      btn.style.cssText = 'background:#8ab4f8;color:#202124;border:0;border-radius:8px;padding:10px 22px;font-size:14px;font-weight:600;cursor:pointer';
      const cancel = document.createElement('button');
      cancel.textContent = '取消';
      cancel.style.cssText = 'margin-left:10px;background:none;color:#9aa0a6;border:0;cursor:pointer;font-size:14px';
      box.appendChild(title); box.appendChild(tip); box.appendChild(btn); box.appendChild(cancel);
      mask.appendChild(box);
      (document.body || document.documentElement).appendChild(mask);
      let settled = false;
      const close = () => { if (!settled) { settled = true; mask.remove(); } };
      cancel.addEventListener('click', () => { close(); resolve(null); });
      btn.addEventListener('click', async () => {
        settled = true;
        mask.remove();
        const r = await pickerViaInput(folder);
        resolve(r && !r.blocked ? r : null);
      });
    });
  }

  async function chooseImages(folder) {
    // 第一层：原生文件夹选择 API（Chrome / Edge）
    if (folder && typeof window.showDirectoryPicker === 'function') {
      const ua = navigator.userActivation;
      if (!ua || ua.transient) {
        try {
          const dir = await window.showDirectoryPicker({ mode: 'read' });
          const out = [];
          await walkDir(dir, '', out);
          out.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
          return { files: out.map((o) => o.file), paths: out.map((o) => o.path), handle: dir };
        } catch (e) {
          if (e && e.name === 'AbortError') return null; // 用户取消
          log('⚠ 原生文件夹选择不可用（' + ((e && e.name) || e) + '），改用上传控件');
        }
      }
    }
    // 第二层：input 控件；第三层：缺少用户手势或被拦截时，弹出页面内按钮
    const ua2 = navigator.userActivation;
    let r = null;
    if (!ua2 || ua2.transient) {
      r = await pickerViaInput(folder);
      if (r && r.blocked) r = null;
    }
    if (!r) r = await pickerViaButton(folder);
    if (!r || r.blocked) return null;
    return r;
  }

  /* ============================================================
   * 九、配置面板（主界面）
   * ============================================================ */
  let panelEl = null, launcherEl = null;
  let folderLabelEl = null, promptBox = null, runBtn = null, stopBtn = null;
  let pickedFiles = null;   // 本次已选图片
  let pickedLabel = '';     // 「文件夹名 · N 张」
  const logLines = [];

  function ensureLauncher() {
    if (launcherEl && launcherEl.isConnected) return launcherEl;
    launcherEl = document.createElement('div');
    launcherEl.title = 'Gemini 批量图片生成 v' + SCRIPT_VERSION + '（Alt+G 打开/关闭面板）';
    launcherEl.textContent = '🖼';
    launcherEl.style.cssText = [
      'position:fixed', 'right:20px', 'bottom:20px', 'z-index:2147483646',
      'width:44px', 'height:44px', 'border-radius:50%', 'cursor:pointer',
      'background:#1e1f22', 'color:#8ab4f8', 'border:1px solid #3c4043',
      'display:flex', 'align-items:center', 'justify-content:center',
      'font-size:20px', 'box-shadow:0 4px 14px rgba(0,0,0,.4)', 'user-select:none'
    ].join(';');
    launcherEl.addEventListener('click', togglePanel);
    (document.body || document.documentElement).appendChild(launcherEl);
    return launcherEl;
  }

  function ensurePanel() {
    if (panelEl && panelEl.isConnected) return panelEl;
    if (panelEl) panelEl.remove();
    panelEl = document.createElement('div');
    panelEl.style.cssText = [
      'position:fixed', 'right:20px', 'bottom:76px', 'z-index:2147483646',
      'width:360px', 'max-height:78vh', 'display:none', 'flex-direction:column',
      'background:#1e1f22', 'color:#e3e3e3', 'font:12px/1.6 system-ui,sans-serif',
      'border:1px solid #3c4043', 'border-radius:12px',
      'box-shadow:0 6px 24px rgba(0,0,0,.45)', 'overflow:hidden'
    ].join(';');

    /* ---- 标题栏（可拖动） ---- */
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:9px 12px;background:#2a2b2f;cursor:move;user-select:none;font-weight:600;font-size:13px';
    head.textContent = '🖼 Gemini 批量图片生成 v' + SCRIPT_VERSION;
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.title = '收起面板';
    closeBtn.style.cssText = 'margin-left:auto;background:none;border:0;color:#9aa0a6;cursor:pointer;font-size:15px;line-height:1';
    closeBtn.addEventListener('click', (ev) => { ev.stopPropagation(); panelEl.style.display = 'none'; });
    head.appendChild(closeBtn);

    /* ---- 内容区 ---- */
    const body = document.createElement('div');
    body.style.cssText = 'padding:10px 12px;overflow:auto';

    // 文件夹
    const row1 = document.createElement('div');
    row1.style.cssText = 'margin-bottom:8px';
    const folderBtn = document.createElement('button');
    folderBtn.textContent = '📁 选择文件夹…';
    folderBtn.style.cssText = 'background:#2a2b2f;color:#e3e3e3;border:1px solid #3c4043;border-radius:8px;padding:7px 12px;cursor:pointer;font-size:12px';
    folderBtn.addEventListener('click', chooseFolderClick);
    folderLabelEl = document.createElement('div');
    folderLabelEl.style.cssText = 'margin-top:5px;color:#9aa0a6;font-size:11px;word-break:break-all';
    folderLabelEl.textContent = '未选择';
    row1.appendChild(folderBtn);
    row1.appendChild(folderLabelEl);
    body.appendChild(row1);

    // 提示词
    const row2 = document.createElement('div');
    row2.style.cssText = 'margin-bottom:8px';
    const pLabel = document.createElement('div');
    pLabel.textContent = '提示词（自动保存，对所有图片生效）：';
    pLabel.style.cssText = 'margin-bottom:4px;color:#bdc1c6';
    promptBox = document.createElement('textarea');
    promptBox.rows = 3;
    promptBox.placeholder = '例如：把画面改成下雪的冬天';
    promptBox.value = cfg.defaultPrompt || '';
    promptBox.style.cssText = 'width:100%;box-sizing:border-box;background:#141517;color:#e3e3e3;border:1px solid #3c4043;border-radius:8px;padding:7px 9px;font:12px/1.6 system-ui,sans-serif;resize:vertical';
    promptBox.addEventListener('input', () => {
      cfg.defaultPrompt = promptBox.value;
      saveCfg();
    });
    row2.appendChild(pLabel);
    row2.appendChild(promptBox);
    body.appendChild(row2);

    // 选项
    const row3 = document.createElement('div');
    row3.style.cssText = 'display:flex;gap:14px;margin-bottom:10px;color:#bdc1c6;font-size:11.5px;flex-wrap:wrap';
    const cb1 = makeCheckbox('每张图新开对话', cfg.newChatPerImage, (v) => { cfg.newChatPerImage = v; saveCfg(); });
    const cb2 = makeCheckbox('严格原文件名', cfg.exactName, (v) => { cfg.exactName = v; saveCfg(); });
    row3.appendChild(cb1);
    row3.appendChild(cb2);
    body.appendChild(row3);

    // 按钮行
    const row4 = document.createElement('div');
    row4.style.cssText = 'display:flex;gap:8px;margin-bottom:10px';
    runBtn = document.createElement('button');
    runBtn.textContent = '▶ 执行';
    runBtn.style.cssText = 'flex:1;background:#8ab4f8;color:#202124;border:0;border-radius:8px;padding:9px 0;font-size:13px;font-weight:700;cursor:pointer';
    runBtn.addEventListener('click', executeClick);
    stopBtn = document.createElement('button');
    stopBtn.textContent = '⏹ 停止';
    stopBtn.style.cssText = 'background:#3c2f30;color:#f28b82;border:1px solid #5d4037;border-radius:8px;padding:9px 14px;font-size:12px;cursor:pointer';
    stopBtn.addEventListener('click', stopQueue);
    const diagBtn = document.createElement('button');
    diagBtn.textContent = '🔍 诊断';
    diagBtn.title = '检查页面元素（出问题时把结果反馈给维护者）';
    diagBtn.style.cssText = 'background:#2a2b2f;color:#9aa0a6;border:1px solid #3c4043;border-radius:8px;padding:9px 10px;font-size:12px;cursor:pointer';
    diagBtn.addEventListener('click', runDiag);
    row4.appendChild(runBtn);
    row4.appendChild(stopBtn);
    row4.appendChild(diagBtn);
    body.appendChild(row4);

    // 进度与日志
    const list = document.createElement('div');
    list.className = 'gicp-list';
    list.style.cssText = 'margin-bottom:6px';
    const logEl = document.createElement('div');
    logEl.className = 'gicp-log';
    logEl.style.cssText = 'white-space:pre-wrap;color:#bdc1c6;font-family:Consolas,Menlo,monospace;font-size:11px;max-height:160px;overflow:auto;border-top:1px dashed #3c4043;padding-top:6px';
    body.appendChild(list);
    body.appendChild(logEl);

    panelEl.appendChild(head);
    panelEl.appendChild(body);
    (document.body || document.documentElement).appendChild(panelEl);

    // 面板拖动
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    head.addEventListener('mousedown', (ev) => {
      dragging = true; sx = ev.clientX; sy = ev.clientY;
      const r = panelEl.getBoundingClientRect();
      ox = r.left; oy = r.top;
      ev.preventDefault();
    });
    window.addEventListener('mousemove', (ev) => {
      if (!dragging) return;
      panelEl.style.left = Math.max(0, ox + ev.clientX - sx) + 'px';
      panelEl.style.top = Math.max(0, oy + ev.clientY - sy) + 'px';
      panelEl.style.right = 'auto';
      panelEl.style.bottom = 'auto';
    });
    window.addEventListener('mouseup', () => { dragging = false; });

    return panelEl;
  }

  function makeCheckbox(text, checked, onChange) {
    const label = document.createElement('label');
    label.style.cssText = 'display:flex;align-items:center;gap:5px;cursor:pointer';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!checked;
    cb.addEventListener('change', () => onChange(cb.checked));
    const span = document.createElement('span');
    span.textContent = text;
    label.appendChild(cb);
    label.appendChild(span);
    return label;
  }

  function panelShow() {
    const p = ensurePanel();
    p.style.display = 'flex';
    updatePanelState();
  }

  function togglePanel() {
    const p = ensurePanel();
    p.style.display = (p.style.display === 'flex') ? 'none' : 'flex';
    if (p.style.display === 'flex') updatePanelState();
  }

  /* ---- 面板状态刷新 ---- */
  async function updatePanelState() {
    if (!panelEl || !folderLabelEl || !runBtn || !stopBtn) return;
    const m = metaLoad();
    const running = !!(m && !m.done && !m.stopped);
    const stopped = !!(m && !m.done && m.stopped);
    const hasPending = stopped && m.statuses.some((s) => s === 'pending');
    let label = pickedLabel || '';
    if (!label) {
      // 显示记住的文件夹（若有）
      try {
        const h = await loadDirHandle();
        if (h && h.name) label = '上次文件夹：' + h.name + '（点「执行」时可直接使用，浏览器可能要求重新授权）';
      } catch (e) {}
    }
    folderLabelEl.textContent = label || '未选择（受浏览器安全限制，文件夹需通过选择框指定，指定一次后会被记住）';
    runBtn.textContent = hasPending ? '▶ 继续' : '▶ 执行';
    runBtn.disabled = running;
    runBtn.style.opacity = running ? '.5' : '1';
    stopBtn.disabled = !running;
    stopBtn.style.opacity = running ? '1' : '.5';
  }

  /* ---- 选择文件夹 ---- */
  async function chooseFolderClick() {
    const r = await chooseImages(true);
    if (r && r.files && r.files.length) {
      pickedFiles = r.files;
      const folderName = String(r.paths[0] || '').split('/')[0] || '(未知)';
      pickedLabel = folderName + ' · ' + r.files.length + ' 张图片';
      if (r.handle) saveDirHandle(r.handle);
      log('📂 已选择文件夹：' + folderName + '，共 ' + r.files.length + ' 张图片');
      if (r.files.length > 80) toast('提示：一次排队 ' + r.files.length + ' 张，如遇浏览器存储不足可分批处理', 6000);
      updatePanelState();
    } else {
      toast('未选择文件夹');
    }
  }

  /* ---- 执行 ---- */
  async function executeClick() {
    const q = metaLoad();
    if (q && !q.done && !q.stopped) { toast('队列正在执行中'); return; }

    // 续跑：检测到已停止且仍有未完成图片时，从断点继续
    if (q && !q.done && q.stopped) {
      const hasPending = q.statuses.some((s) => s === 'pending');
      if (hasPending) {
        q.stopped = false;
        metaSave(q);
        log('▶ 继续执行队列（从第 ' + (q.idx + 1) + ' 张开始）');
        updatePanelState();
        processQueue();
        return;
      }
    }

    // 本次会话已选过 → 直接用；否则尝试上次的文件夹句柄
    let files = pickedFiles;
    if (!files || !files.length) {
      try {
        const h = await loadDirHandle();
        if (h) {
          let perm = 'denied';
          try { perm = await h.queryPermission({ mode: 'read' }); } catch (e) {}
          if (perm !== 'granted' && navigator.userActivation) {
            try { perm = await h.requestPermission({ mode: 'read' }); } catch (e) {}
          }
          if (perm === 'granted') {
            const out = [];
            await walkDir(h, '', out);
            out.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
            files = out.map((o) => o.file);
            if (files.length) {
              pickedFiles = files;
              pickedLabel = (h.name || '(未知)') + ' · ' + files.length + ' 张图片';
              log('📂 使用上次文件夹：' + (h.name || '') + '，共 ' + files.length + ' 张图片');
            }
          }
        }
      } catch (e) { /* 句柄不可用，走选择流程 */ }
    }
    if (!files || !files.length) {
      toast('请先点击「选择文件夹」选择图片所在文件夹');
      return;
    }

    const prompt = (promptBox ? promptBox.value : cfg.defaultPrompt || '').trim();
    if (!prompt) {
      toast('请先填写提示词');
      if (promptBox) promptBox.focus();
      return;
    }
    cfg.defaultPrompt = prompt;
    saveCfg();
    if (files.length > 80) toast('提示：一次排队 ' + files.length + ' 张，如遇浏览器存储不足可分批处理', 6000);
    await startRun(files, prompt);
  }

  /* ---- 进度列表 / 日志 ---- */
  function renderList(m) {
    if (!panelEl || !m) return;
    const list = panelEl.querySelector('.gicp-list');
    if (!list) return;
    const icons = { pending: '⏸', busy: '⏳', ok: '✅', err: '❌' };
    // 用 DOM API 构建而非 innerHTML：gemini.google.com 已下发 require-trusted-types-for（目前为 Report-Only），
    // 一旦正式启用，innerHTML 赋字符串会抛 TypeError 并中断队列
    list.textContent = '';
    m.names.forEach((n, i) => {
      const st = m.statuses[i] || 'pending';
      const err = m.errors && m.errors[i];
      const row = document.createElement('div');
      row.textContent = '【' + (icons[st] || '⏸') + '】' + (i + 1) + '. ' + n;
      if (st === 'err' && err) {
        const span = document.createElement('span');
        span.style.color = '#f28b82';
        span.textContent = ' ' + String(err).slice(0, 50);
        row.appendChild(span);
      }
      list.appendChild(row);
    });
  }

  function panelSetState(m, i, status) {
    if (!m) return;
    m.statuses[i] = status;
    renderList(m);
  }

  function log(msg) {
    const line = '[' + now() + '] ' + msg;
    console.log('[gic]', msg);
    logLines.push(line);
    if (logLines.length > 300) logLines.splice(0, logLines.length - 300);
    try {
      const p = ensurePanel();
      const el = p.querySelector('.gicp-log');
      if (el) {
        el.textContent = logLines.slice(-80).join('\n') + '\n';
        el.scrollTop = el.scrollHeight;
      }
    } catch (e) { /* 忽略 */ }
  }

  /* ---- 诊断（Google 改版后的排查工具） ---- */
  function describeEl(el) {
    if (!el) return 'null';
    let s = '<' + el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const cls = String(el.className || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
    if (cls) s += '.' + cls;
    return s + '>';
  }

  function runDiag() {
    const lines = [];
    let ver = SCRIPT_VERSION;
    try { ver = GM_info.script.version || SCRIPT_VERSION; } catch (e) {}
    lines.push('脚本版本：' + ver + (ver === '?' ? '（无法读取，请检查是否用 Tampermonkey 安装）' : ''));
    lines.push('文件夹选择方式：' + (typeof window.showDirectoryPicker === 'function' ? '原生 API ✅' : '上传控件（兜底）'));
    lines.push('userActivation：' + (navigator.userActivation ? '支持' : '不支持（旧浏览器）'));
    const ed = getEditor();
    const allEds = document.querySelectorAll(EDITOR_SELS.join(','));
    lines.push('输入框：' + (ed ? '✅ ' + describeEl(ed) : '❌ 未找到') + '（候选 ' + allEds.length + ' 个，可见 ' + [...allEds].filter(isVisible).length + ' 个）');
    const cr = composerRoot();
    lines.push('输入区容器：' + (cr ? '✅ ' + describeEl(cr) : '❌ 未找到'));
    const sb = findSendButton();
    lines.push('发送按钮：' + (sb ? '✅ ' + (sb.getAttribute('aria-label') || describeEl(sb)) : '❌ 未找到'));
    const ncb = tryFindNewChatButton();
    lines.push('新对话按钮：' + (ncb ? '✅ ' + (ncb.getAttribute('aria-label') || (ncb.textContent || '').trim().slice(0, 20)) : '❌ 未找到'));
    const inputs = [...document.querySelectorAll('input[type="file"]')];
    lines.push('文件输入框：' + inputs.length + ' 个');
    lines.push('附件预览元素（blob 图/预览组件）：' + [...document.querySelectorAll(PREVIEW_SEL)].filter((el) => isVisible(el) && !inResponseArea(el)).length + ' 个');
    inputs.slice(0, 3).forEach((i) => lines.push('  - accept=' + (i.accept || '(空)')));
    lines.push('回复容器数量：' + countResponses());
    const bigImgs = [...document.querySelectorAll('img')].filter((i) => (i.naturalWidth || 0) >= cfg.minImgSize);
    lines.push('页面大图（≥' + cfg.minImgSize + 'px）：' + bigImgs.length + ' 张');
    bigImgs.slice(-3).forEach((i) => lines.push('  - ' + i.naturalWidth + '×' + i.naturalHeight + ' ' + String(i.currentSrc || i.src || '').slice(0, 70)));
    const msg = lines.join('\n');
    log('诊断完成');
    alert(msg + '\n\n提示：若关键元素为 ❌，说明 Google 改了页面结构。\n请把以上内容截图反馈，以便更新选择器。');
  }

  /* ============================================================
   * 十、快捷键 / 菜单 / 启动
   * ============================================================ */
  // Alt+G 打开/关闭配置面板
  document.addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 'g' || e.key === 'G')) {
      e.preventDefault();
      try { ensureLauncher(); } catch (err) {}
      togglePanel();
    }
  });

  try {
    GM_registerMenuCommand('🖼 打开/关闭配置面板', () => togglePanel());
    GM_registerMenuCommand('⏹ 停止当前队列', () => stopQueue());
    GM_registerMenuCommand('🔍 诊断页面元素', () => runDiag());
  } catch (e) { /* 菜单注册失败不影响主功能 */ }

  async function boot() {
    // 等 document.body 可用（不依赖固定延时，body 一出现就显示按钮）
    const bodyReady = await waitFor(() => document.body, 30000, 300);
    if (!bodyReady) {
      console.error('[gic] document.body 30 秒内未就绪，界面未创建');
      return;
    }
    try {
      ensureLauncher();
      ensurePanel();
      console.log('[gic] 悬浮按钮与面板已创建（右下角 🖼）');
    } catch (e) {
      console.error('[gic] 界面创建失败：', e);
      toast('面板创建失败：' + ((e && e.message) || e), 8000);
      return;
    }
    // 看门狗：界面若被页面移除，自动补回
    setInterval(() => {
      try {
        if (!launcherEl || !launcherEl.isConnected) ensureLauncher();
      } catch (e) { /* 忽略 */ }
    }, 4000);

    await sleep(1200);
    try {
      const m = metaLoad();
      if (m && !m.done && !m.stopped) {
        log('↻ 检测到未完成的队列，自动续跑…');
        panelShow();
        processQueue();
      } else if (m && !m.done && m.stopped) {
        log('⏸ 检测到已停止的队列（点「继续」可从断点执行）');
        panelShow();
      } else if (!sessionStorage.getItem('gic-hint')) {
        sessionStorage.setItem('gic-hint', '1');
        panelShow();
        toast('已启用批量图片生成：在面板中选好文件夹、填好提示词，点「执行」即可', 6000);
      } else {
        updatePanelState();
      }
    } catch (e) {
      console.error('[gic] boot:', e);
      toast('启动出错：' + ((e && e.message) || e), 8000);
    }
  }

  boot();
})();
