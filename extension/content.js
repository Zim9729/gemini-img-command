/* ---- GM_* API shim（Chrome/Edge 扩展模式，不依赖 Tampermonkey） ----
 * GM_setValue / GM_getValue：同步，用 localStorage（脚本本身已有回退逻辑）
 * GM_registerMenuCommand：扩展无油猴菜单，空实现
 * GM_xmlhttpRequest：通过 background service worker 跨域 fetch
 * GM_info：提供脚本版本等元信息（runDiag 诊断用）
 */
const GM_setValue = (k, v) => { try { localStorage.setItem('gic-gm:' + k, String(v)); } catch (e) {} };
const GM_getValue  = (k, d) => { try { const v = localStorage.getItem('gic-gm:' + k); return v === null ? d : v; } catch (e) { return d; } };
const GM_registerMenuCommand = function () {};
const GM_info = { script: { version: '2.5.3', name: 'Gemini 批量图片生成面板' } };
const GM_xmlhttpRequest = (opts) => {
  // 超时契约与用户脚本 v2.3.2 对齐：background 无响应（fetch 挂起/worker 消失）时
  // 触发 ontimeout，防止队列永久卡死（用户脚本对 GM_xhr 传 timeout: 60000）
  const tmo = (typeof opts.timeout === 'number' && opts.timeout > 0) ? opts.timeout : 60000;
  let settled = false;
  const tid = setTimeout(() => {
    if (settled) return;
    settled = true;
    if (opts.ontimeout) opts.ontimeout();
  }, tmo);
  chrome.runtime.sendMessage(
    { type: 'gmxhr', opts: { method: opts.method || 'GET', url: opts.url, timeout: tmo } },
    (resp) => {
      clearTimeout(tid);
      if (settled) return; // 超时已触发，丢弃迟到的响应
      settled = true;
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
 *    5. 「🗑 重置」随时清掉当前队列与已选文件（提示词、选项、记住的文件夹保留）
 *    6. 检测到用量限额（「额度重置/限额/quota…」纯文字回复）时自动等待额度恢复：
 *       优先读取「查看用量」页的当前用量重置时间；其次解析回复中的明确时间，最后按面板间隔
 *       （默认 30 分钟）轮询；到点自动重试当前张，额度恢复后队列继续，不记为失败
 *
 *  说明：受浏览器安全限制，无法直接输入本地路径文本，文件夹通过
 *  系统选择框指定一次即可，脚本会持久化记住（执行时无需再选）。
 * ────────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  /* ---- 版本标识与加载横幅（F12 控制台过滤 gic 即可确认脚本是否在运行） ---- */
  // 版本以 @version 为准：运行时读 GM_info（Tampermonkey 始终同步提供），字面量仅作无沙箱兜底，
  // 消除两处手工双写漂移的可能
  let SCRIPT_VERSION = '2.5.3';
  try {
    if (typeof GM_info !== 'undefined' && GM_info && GM_info.script && GM_info.script.version) {
      SCRIPT_VERSION = GM_info.script.version;
    }
  } catch (e) {}
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
    matchSize: true,               // 生成图与原图尺寸不同时，保存前在内存中缩放为原图尺寸
    waitTimeoutMs: 300 * 1000,     // 单张图等待生成的超时（5 分钟）
    uploadTimeoutMs: 120 * 1000,   // 等待附件上传完成的超时（2 分钟）
    minImgSize: 200,               // 判定为「生成图」的最小宽度(px)
    uploadPath: 'paste',           // 上次成功的上传途径（paste/drop/input），下次优先尝试，避免在失效途径上反复白等超时
    quotaRetryMs: 30 * 60 * 1000,  // 检测到用量限额后，等待额度恢复的重试间隔（默认 30 分钟，面板「限额等待」可改）
    quotaResetAt: 0,               // 从 Gemini「查看用量」页读取的当前用量重置绝对时刻
  };

  function safeParse(s) {
    // GM_getValue 可能取出旧版直接存的对象（GM_setValue 支持结构化克隆值）：
    // JSON.parse(对象) 会抛错回退 {}，导致配置静默重置——对象直接放行
    if (s && typeof s === 'object') return s;
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
    // 兜底：缺省/非法超时一律按 10 分钟处理，避免未来调用方传错参数导致永不超时
    if (typeof timeout !== 'number' || !(timeout >= 0)) timeout = 600000;
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

  /* ---- toast：多条依次向下堆叠，避免同时弹出时互相遮盖 ---- */
  const activeToasts = [];
  function layoutToasts() {
    let top = 18;
    for (const t of activeToasts) {
      t.style.top = top + 'px';
      top += (t.offsetHeight || 44) + 8;
    }
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
      activeToasts.push(d);
      layoutToasts();
      setTimeout(() => {
        d.style.transition = 'opacity .4s';
        d.style.opacity = '0';
        // 淡出期间保留占位（不与后续 toast 重叠），移除后再收拢其余 toast
        setTimeout(() => {
          const i = activeToasts.indexOf(d);
          if (i >= 0) activeToasts.splice(i, 1);
          d.remove();
          layoutToasts();
        }, 450);
      }, ms || 3500);
    } catch (e) { /* 忽略 */ }
  }

  /* ============================================================
   * 三、队列持久化（localStorage 存元信息 + IndexedDB 存图片文件）
   * ============================================================ */
  const META_KEY = 'gic-queue';

  // 读取并规范化队列元信息：补齐/修复旧版本或损坏数据缺失的字段。
  // 否则 updatePanelState / executeClick 里的 m.statuses.some(...) 会抛 TypeError，
  // 而 async 点击处理器没有 catch，表现为「点按钮无响应」只剩控制台报错
  function metaLoad() {
    let m = null;
    try { m = JSON.parse(localStorage.getItem(META_KEY) || 'null'); } catch (e) { m = null; }
    if (!m || typeof m !== 'object' || !Array.isArray(m.names)) return null;
    if (!Array.isArray(m.statuses) || m.statuses.length !== m.names.length) {
      m.statuses = m.names.map((_, i) => (Array.isArray(m.statuses) ? m.statuses[i] : undefined) || 'pending');
    }
    if (!m.errors || typeof m.errors !== 'object') m.errors = {};
    if (typeof m.idx !== 'number' || !Number.isInteger(m.idx) || m.idx < 0 || m.idx > m.names.length) {
      // idx 异常时按「第一个未完成项」重建
      let idx = m.names.length;
      for (let i = 0; i < m.names.length; i++) {
        if (m.statuses[i] !== 'ok' && m.statuses[i] !== 'err') { idx = i; break; }
      }
      m.idx = idx;
    }
    if (typeof m.prompt !== 'string') m.prompt = '';
    if (typeof m.id !== 'string') m.id = ''; // 队列代 ID（见 processQueue 的替换检测）
    m.done = !!m.done;
    m.stopped = !!m.stopped;
    return m;
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

  // 清掉 IndexedDB 里越界的 file:* 残留：上一轮更大的/中途放弃的队列留下的 blob 会永久占着存储，
  // 每次开新任务前按「本轮文件数」清扫一遍（不清 dirHandle）
  async function fileSweep(keepCount) {
    try {
      const keys = await idbOp(null, 'readonly', (s) => s.getAllKeys()).catch(() => []);
      if (!Array.isArray(keys)) return;
      for (const k of keys) {
        if (typeof k === 'string' && k.indexOf('file:') === 0) {
          // 按原始键删除：非数字后缀（如 file:abc）parseInt 得 NaN，
          // 旧实现拼出 file:NaN 删不到真正的键，残留会永久占着存储
          const n = parseInt(k.slice(5), 10);
          const keep = Number.isInteger(n) && n >= 0 && n < keepCount && String(n) === k.slice(5);
          if (!keep) await idbOp(k, 'readwrite', (s) => s.delete(k)).catch(() => {});
        }
      }
    } catch (e) { /* 清理失败不阻塞新任务 */ }
  }

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
    // 写后回读：两个标签页同一毫秒都读到过期锁时，后写者获胜，先写者在此退让
    const chk = lockInfo();
    return !chk || chk.tab === TAB_ID;
  }
  function lockHeldByMe() {
    const lk = lockInfo();
    return !!lk && lk.tab === TAB_ID;
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

  // requireEnabled=true：用于「点发送」，必须可用；false：用于完成判定，只看存在且可见——
  // 发送后编辑器被清空，新版界面可能把发送键置灰（disabled）留在原位，若此时仍要求可用，
  // 完成判定永远等不到「发送键恢复」，每张图都白等满单张超时（表现为图已生成但脚本不动）
  function findSendBtn(requireEnabled) {
    const enabledOk = (b) => !requireEnabled || !b.disabled;
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
        const list = [...root.querySelectorAll(sel)].filter((b) => enabledOk(b) && b.getClientRects().length);
        if (list.length) return list[list.length - 1];
      }
      // 图标名兜底（Material 图标 send / arrow_upward）
      const icons = [...root.querySelectorAll('button mat-icon, button .material-symbols-outlined, button [fonticon]')];
      for (const ic of icons) {
        const name = (ic.textContent || ic.getAttribute('fonticon') || '').trim().toLowerCase();
        if (name === 'send' || name === 'arrow_upward') {
          const b = ic.closest('button');
          if (b && enabledOk(b) && b.getClientRects().length) return b;
        }
      }
    }
    // 结构兜底（Google 改版改掉发送键的 class/aria-label/图标名时——v2.4.0 诊断反馈：
    // 发送按钮 ❌ 而其余关键元素全部 ✅）：发送键是输入区末尾（最右侧）的动作按钮。
    // 排除停止键与麦克风/上传/添加附件类左侧工具按钮，避免误点听写或附件入口
    if (cr) {
      const btnIconNames = (b) => [...b.querySelectorAll('mat-icon, .material-symbols-outlined, [fonticon]')]
        .map((ic) => (ic.textContent || ic.getAttribute('fonticon') || '').trim().toLowerCase());
      const isStopish = (b) => {
        const t = (b.getAttribute('aria-label') || '') + (b.getAttribute('mattooltip') || '');
        if (/stop|停止/i.test(t)) return true;
        return btnIconNames(b).some((n) => n === 'stop' || n === 'stop_circle');
      };
      const isSideBtn = (b) => {
        const t = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('mattooltip') || '');
        if (/mic|dictat|voice|语音|麦克风|听写|upload|上传|attach|附件|添加|相机|camera|文件|相册|相片|图片|photo|gallery|drive/i.test(t)) return true;
        return btnIconNames(b).some((n) => /mic|photo_camera|attach_file|^add$|^upload|^image/.test(n));
      };
      const btns = [...cr.querySelectorAll('button, [role="button"]')]
        .filter((b) => enabledOk(b) && b.getClientRects().length && isVisible(b))
        .filter((b) => !isStopish(b) && !isSideBtn(b));
      let best = null;
      for (const b of btns) {
        if (!best || b.getBoundingClientRect().right > best.getBoundingClientRect().right) best = b;
      }
      if (best) return best;
    }
    return null;
  }

  function findSendButton() { return findSendBtn(true); }
  // 完成判定用：发送键「存在即可」（含置灰状态），见 findSendBtn 注释
  function sendButtonVisible() { return findSendBtn(false); }

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

  // 回复容器选择器全部失效（Google 改版）时 countResponses() 恒为 0：
  // 页面上若仍有用户消息节点，说明并非新对话，不能据此误判而跳过新对话切换
  const isFreshChat = () => !!getEditor() && (/^\/app\/?$/.test(location.pathname)
    || (countResponses() === 0 && !document.querySelector('user-query, .query-content')));

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

  // 用户消息（user-query）里的图片地址集合：回复中「回显的原图」与用户消息同址，据此排除，
  // 否则多图回复里回显的原图会被当成生成图存成 _2 副本。主路径与无容器兜底共用
  function collectUserQuerySrcs() {
    const set = new Set();
    [...document.querySelectorAll('user-query, .query-content, [data-test-id*="query"]')].forEach((q) => {
      [...q.querySelectorAll('img')].forEach((im) => {
        const s = im.currentSrc || im.src || '';
        if (s) set.add(s);
      });
    });
    return set;
  }

  function isGeneratedImg(im) {
    if (!im.complete || !im.naturalWidth) return false;
    if (im.closest('user-query, .query-content, [data-test-id*="query"]')) return false; // 排除用户消息里的原图
    if (inComposer(im)) return false;                                                      // 排除输入框预览
    return im.naturalWidth >= cfg.minImgSize;
  }

  // 收集生成图。skipCount/skipEls 限定只扫描「发送后新增」的回复：
  // 在当前对话续跑（新对话按钮找不到时的回退路径，或关闭了每图新对话）且本条回复
  // 是纯文字/被拒绝时，若扫描全部回复会把上一条历史回复的图当成结果，按当前文件名存错图。
  // prevSrcs：sendAndWait 在点击发送前拍的全页图片 src 快照，供容器选择器失效时的兜底收集用
  function collectResponseImages(skipCount, skipEls, prevSrcs) {
    skipCount = skipCount || 0;
    const userSrcs = collectUserQuerySrcs();
    const list = [...document.querySelectorAll(RESP_SELS)];
    // 长对话虚拟滚动会移除旧回复节点，使 list.length < skipCount（位置水位失真）→
    // 退化为纯身份比对（只扫不在快照集合里的回复）；水位仍有效时两种判断并用
    // （身份防删减/移位，水位防旧节点被框架原地重建后漏判）
    const positionalOk = list.length >= skipCount;
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i];
      if (skipEls && skipEls.has(c)) continue;
      if (positionalOk && i < skipCount) continue;
      if (c.closest('user-query, .query-content, [data-test-id*="query"]')) continue;
      let imgs = [...c.querySelectorAll('img')].filter(isGeneratedImg);
      if (userSrcs.size) imgs = imgs.filter((im) => !userSrcs.has(im.currentSrc || im.src || ''));
      if (imgs.length) return imgs;
    }
    // 兜底（Google 改版把回复容器改名时主路径一无所获，表现为 Gemini 明明出了图、
    // 脚本却逐张报「回复中没有生成图片」——用户诊断反馈：页面上 12 张生成大图均为
    // blob: 地址而主路径抓不到）：不依赖容器，按两个与结构无关的事实收集——
    //   ① 生成图位于「最后一条用户消息」之后（DOM 顺序，对话 UI 的固有结构）
    //   ② 生成图的 src 是发送前不存在的（历史回复的图都在发送前快照里；用户消息里
    //      回显的原图与发送前输入框预览同 blob 地址，一并被快照排除）
    // 容器正常时永远走不到这里，主路径的 skipCount/skipEls 精确性不受影响
    if (!prevSrcs || !prevSrcs.size) return [];
    let imgs = [...document.querySelectorAll('img')].filter(isGeneratedImg)
      .filter((im) => !userSrcs.has(im.currentSrc || im.src || ''))
      .filter((im) => !prevSrcs.has(im.currentSrc || im.src || ''));
    const qs = [...document.querySelectorAll('user-query, .query-content, [data-test-id*="query"]')];
    const lastQuery = qs.length ? qs[qs.length - 1] : null;
    if (lastQuery) {
      imgs = imgs.filter((im) => {
        if (lastQuery.contains(im)) return false; // 用户消息内部的回显原图
        try { return !!(lastQuery.compareDocumentPosition(im) & Node.DOCUMENT_POSITION_FOLLOWING); }
        catch (e) { return true; }
      });
    }
    return imgs;
  }

  // 用量限额检测：Gemini 免费额度用尽时回复纯文字（如「一旦您的额度重置，我就可以创建更多图片。
  // 请在"设置"中查看您的使用情况。」），无图。在中英文常见表述里做特征匹配，
  // 只扫「本次发送后新增」的回复（与 collectResponseImages 同一范围），配合「无图」前提误报率很低
  const QUOTA_PATTERNS = [
    /额度/, /限额/, /配额/, /用量/, /已达.{0,12}上限/,
    /quota/i, /rate limit/i, /usage limit/i, /daily limit/i,
    /once your (quota|limit|usage)/i, /reached your limit/i, /create more images/i
  ];

  function quotaDetected(skipCount, skipEls) {
    const list = [...document.querySelectorAll(RESP_SELS)];
    // 与 collectResponseImages 相同的虚拟滚动容错：水位失真时退化为纯身份比对
    const positionalOk = list.length >= (skipCount || 0);
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i];
      if (skipEls && skipEls.has(c)) continue;
      if (positionalOk && i < (skipCount || 0)) continue;
      const t = (c.textContent || '').trim();
      if (t && QUOTA_PATTERNS.some((p) => p.test(t))) return t;
    }
    return null;
  }

  // 从限额回复文本解析明确的恢复时间（如「3 小时后重置」「14:30 恢复」「try again in 2 hours」）。
  // 命中返回等待毫秒数（钳制在 60 秒 ~ 24 小时）；Gemini 的限额回复多数不含具体时间
  // （如「一旦您的额度重置…」），返回 null 时由面板设定的间隔兜底
  function parseQuotaWaitMs(text) {
    const s = String(text || '');
    const clamp = (ms) => {
      if (!Number.isFinite(ms) || ms <= 0) return null;
      return Math.min(Math.max(Math.round(ms), 60000), 24 * 60 * 60 * 1000);
    };
    // 显式时长：X 小时 / X 分钟 / X 秒（中英文，可组合，如「1小时30分钟」「in 2 hours」）
    let total = 0, hit = false, m;
    if ((m = s.match(/(\d+(?:\.\d+)?)\s*(?:个)?小时/)) || (m = s.match(/(\d+(?:\.\d+)?)\s*-?\s*(?:hours?|hrs?)\b/i))) { total += parseFloat(m[1]) * 3600000; hit = true; }
    if ((m = s.match(/(\d+(?:\.\d+)?)\s*分钟/)) || (m = s.match(/(\d+(?:\.\d+)?)\s*-?\s*(?:minutes?|mins?)\b/i))) { total += parseFloat(m[1]) * 60000; hit = true; }
    if ((m = s.match(/(\d+(?:\.\d+)?)\s*秒/)) || (m = s.match(/(\d+(?:\.\d+)?)\s*-?\s*(?:seconds?|secs?)\b/i))) { total += parseFloat(m[1]) * 1000; hit = true; }
    if (hit) return clamp(total);
    // 时钟时刻（14:30 / 14：30 / 2:15 pm）：取下一次出现的该时刻（已过则视为明天）
    m = s.match(/(\d{1,2})[:：](\d{2})\s*(am|pm)?/i);
    if (m) {
      let hh = parseInt(m[1], 10);
      const mm = parseInt(m[2], 10);
      const ap = (m[3] || '').toLowerCase();
      if (ap === 'pm' && hh < 12) hh += 12;
      if (ap === 'am' && hh === 12) hh = 0;
      if (hh < 24 && mm < 60) {
        const n = new Date();
        const target = new Date(n.getFullYear(), n.getMonth(), n.getDate(), hh, mm, 0, 0);
        let delta = target - n;
        if (delta <= 0) delta += 24 * 3600000;
        return clamp(delta);
      }
    }
    // 中文整点（「下午 3 点」）：取下一次出现的该时刻
    m = s.match(/(下午|晚上|凌晨|早上|上午)?\s*(\d{1,2})\s*点/);
    if (m) {
      let hh = parseInt(m[2], 10);
      const mer = m[1] || '';
      if ((mer === '下午' || mer === '晚上') && hh < 12) hh += 12;
      if (hh < 24) {
        const n = new Date();
        const target = new Date(n.getFullYear(), n.getMonth(), n.getDate(), hh, 0, 0, 0);
        let delta = target - n;
        if (delta <= 0) delta += 24 * 3600000;
        return clamp(delta);
      }
    }
    return null;
  }

  // Gemini 聊天页的「用量限额将在…重置」偶尔会与「查看用量」页不一致；后者的
  // 「当前用量 → 重置时间」才是权威值。只在当前用量卡中取值，不能误把「每周限额」
  // 的重置时间当成图片生成额度的重置时间。
  function parseUsageResetAt(text, nowMs) {
    const s = String(text || '').replace(/\u00a0/g, ' ');
    const current = /(?:当前用量|current usage)/i.exec(s);
    if (!current) return null;

    let section = s.slice(current.index, current.index + 1200);
    const nextLimit = section.search(/(?:每周限额|weekly limit|每月限额|monthly limit)/i);
    if (nextLimit >= 0) section = section.slice(0, nextLimit);

    const label = /(?:重置时间|reset time)\s*[：:]?\s*/i.exec(section);
    if (!label) return null;
    const tail = section.slice(label.index + label[0].length, label.index + label[0].length + 80);
    // 支持「20:17」「9月5日 20:17」「9/5 8:17 PM」「下午 8:17」。
    const m = tail.match(/(?:(?:(\d{4})\s*(?:年|[.\/-]))?\s*(\d{1,2})\s*(?:月|[.\/-])\s*(\d{1,2})\s*(?:日)?\s*)?((?:上午|下午|早上|晚上|凌晨)\s*)?(\d{1,2})\s*[:：]\s*(\d{2})(?:\s*(上午|下午|am|pm))?/i);
    if (!m) return null;

    let hour = parseInt(m[5], 10);
    const minute = parseInt(m[6], 10);
    if (!(hour >= 0 && hour < 24 && minute >= 0 && minute < 60)) return null;
    const meridiem = ((m[4] || '') + ' ' + (m[7] || '')).trim().toLowerCase();
    if ((meridiem === 'pm' || /下午|晚上/.test(meridiem)) && hour < 12) hour += 12;
    if ((meridiem === 'am' || /上午|早上|凌晨/.test(meridiem)) && hour === 12) hour = 0;

    const now = new Date(Number.isFinite(nowMs) ? nowMs : Date.now());
    let year = now.getFullYear();
    let month = now.getMonth();
    let day = now.getDate();
    const hasDate = !!(m[2] && m[3]);
    if (hasDate) {
      year = m[1] ? parseInt(m[1], 10) : year;
      month = parseInt(m[2], 10) - 1;
      day = parseInt(m[3], 10);
      if (!(month >= 0 && month < 12 && day >= 1 && day <= 31)) return null;
    }

    const target = new Date(year, month, day, hour, minute, 0, 0);
    if (!Number.isFinite(target.getTime())) return null;
    // 时间未带日期时，Gemini 展示的是下一次发生的该时刻；已经过了就属于明天。
    if (!hasDate && target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
    // 带月日但不带年份时，取下一次出现的该月日，覆盖跨年时的用量页展示。
    if (hasDate && !m[1] && target.getTime() < now.getTime()) target.setFullYear(target.getFullYear() + 1);
    return target.getTime();
  }

  function usageResetWaitMs() {
    const resetAt = Number(cfg.quotaResetAt);
    const remaining = resetAt - Date.now();
    // 当前用量的下一次重置不应超过一天；过期/异常缓存不参与等待。
    if (!Number.isFinite(resetAt) || remaining <= 0 || remaining > 25 * 60 * 60 * 1000) return null;
    // 给 Gemini 后端刷新一点余量，避免显示刚到重置时刻但请求仍被限额。
    return Math.round(remaining + 15000);
  }

  function syncUsageResetTime() {
    const body = document.body;
    if (!body) return null;
    const text = body.innerText || body.textContent || '';
    const nowMs = Date.now();
    const previousAt = Number(cfg.quotaResetAt);
    const resetAt = parseUsageResetAt(text, nowMs);
    if (!resetAt) return null;
    // 同一时刻的旧页面文本不会因计时器/日志触发 DOM 变化就变成明天。
    // 用上一轮重置前的时刻再解析一次，确认页面仍在展示同一轮额度。
    if (previousAt > 0 && previousAt <= nowMs && nowMs - previousAt < 24 * 60 * 60 * 1000
      && parseUsageResetAt(text, previousAt - 1) === previousAt) return previousAt;
    if (Number(cfg.quotaResetAt) !== resetAt) {
      cfg.quotaResetAt = resetAt;
      saveCfg();
      log('⏰ 已从「查看用量」同步额度重置时间：'
        + new Date(resetAt).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }));
    }
    return resetAt;
  }

  let usageResetSyncTimer = null;
  let lastUsageResetSyncAt = 0;
  function watchUsageResetTime() {
    const sync = () => {
      usageResetSyncTimer = null;
      lastUsageResetSyncAt = Date.now();
      syncUsageResetTime();
    };
    sync();
    const observer = new MutationObserver(() => {
      if (usageResetSyncTimer) return;
      const delay = Math.max(0, 2000 - (Date.now() - lastUsageResetSyncAt));
      usageResetSyncTimer = setTimeout(sync, delay);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
  }

  let quotaRetryAt = 0;
  async function waitForQuotaRetry(qid, fallbackWaitMs) {
    quotaRetryAt = Date.now() + fallbackWaitMs;
    let selectedResetAt = 0;
    try {
      while (!cancelRequested) {
        const cur = metaLoad();
        if (!cur || cur.id !== qid || cur.stopped || cur.done) return false;
        const resetAt = Number(cfg.quotaResetAt);
        // 只在获得新的有效时刻时修改截止时间；到点后缓存过期也不能退回兜底间隔。
        if (resetAt !== selectedResetAt && usageResetWaitMs() !== null) {
          selectedResetAt = resetAt;
          quotaRetryAt = resetAt + 15000;
          log('⏳ 下次自动重试：' + new Date(quotaRetryAt).toLocaleString('zh-CN', { hour12: false }) + '（查看用量页）');
        }
        const remaining = quotaRetryAt - Date.now();
        if (remaining <= 0) {
          log('⏰ 限额等待已到期，自动重试当前图片并继续剩余队列');
          return true;
        }
        await waitFor(() => {
          const current = metaLoad();
          return !current || current.id !== qid || current.stopped || current.done;
        }, Math.min(remaining, 5000), 500);
      }
      return false;
    } finally {
      quotaRetryAt = 0;
    }
  }

  const fmtDur = (ms) => {
    const min = Math.round(ms / 60000);
    if (min >= 60) return Math.floor(min / 60) + ' 小时 ' + (min % 60) + ' 分钟';
    if (min >= 1) return min + ' 分钟';
    return Math.max(1, Math.round(ms / 1000)) + ' 秒';
  };

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

  // 移除输入区里残留的附件（上一张失败后留下的图片 chip），避免下一张叠加成两张、
  // 发送时一次带出多张图（用户诊断：输入区同时挂着 4 个附件）。
  // Google 改版把移除键的 aria-label 从「移除/删除」改成了「关闭附件」（图标 close），
  // 选择器需覆盖新旧两种叫法，再兜底「输入区内图标为 close 的可见按钮」
  async function clearAttachments() {
    const root = composerRoot();
    if (!root) return;
    const sels = [
      'button[aria-label*="移除"]', 'button[aria-label*="删除"]', 'button[aria-label*="Remove"]', 'button[aria-label*="Delete"]',
      'button[aria-label*="关闭附件"]', 'button[aria-label*="移除附件"]', 'button[aria-label*="删除附件"]',
      'button[aria-label*="Close attachment"]', 'button[aria-label*="Remove file"]', 'button[aria-label*="Remove attachment"]',
      'button[mattooltip*="移除"]', 'button[mattooltip*="Remove"]'
    ];
    for (let n = 0; n < 10; n++) {
      let b = sels.map((s) => [...root.querySelectorAll(s)].filter(isVisible)[0]).find(Boolean);
      // 兜底：输入区内图标名为 close 的可见按钮即附件移除键（label 再怎么改都不怕）
      if (!b) {
        b = [...root.querySelectorAll('button mat-icon, button .material-symbols-outlined, button [fonticon]')]
          .filter(isVisible)
          .filter((ic) => ((ic.textContent || ic.getAttribute('fonticon') || '').trim().toLowerCase() === 'close'))
          .map((ic) => ic.closest('button'))
          .find((btn) => btn && btn.getClientRects().length) || null;
      }
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

  // 文件名整体匹配：在一段文本里找「独立的」文件名，防止前缀碰撞——
  // 残留 chip「sunset-2024-v2.jpg」会让 includes(nameKey) 误匹配当前 nameKey「sunset-2024」。
  // 「整体」= 前后都不是文件名字符（字母/数字/_/-）；长文件名被 chip 截断显示（nameKey + 省略号）也放行
  function textHasWholeName(text, fullName, nameKey) {
    const t = String(text || '');
    if (!t) return false;
    const whole = (name) => {
      if (!name) return false;
      const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      try {
        return new RegExp('(^|[^A-Za-z0-9_\\-])' + esc + '(?=$|[^A-Za-z0-9_\\-])').test(t);
      } catch (e) { return t.indexOf(name) >= 0; }
    };
    if (whole(fullName)) return true;
    if (whole(nameKey)) return true;
    if (nameKey && (t.indexOf(nameKey + '…') >= 0 || t.indexOf(nameKey + '...') >= 0)) return true;
    return false;
  }

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

  // 模拟拖放文件到编辑器（paste 不生效时的备选途径）
  function uploadViaDrop(file) {
    const ed = getEditor();
    if (!ed) return false;
    try {
      ed.focus();
      const dt = new DataTransfer();
      dt.items.add(file);
      const opts = { bubbles: true, cancelable: true, dataTransfer: dt };
      // dragenter / dragover 是 drop 的前置事件，很多页面的 drop handler 依赖它们
      ed.dispatchEvent(new DragEvent('dragenter', opts));
      ed.dispatchEvent(new DragEvent('dragover', opts));
      ed.dispatchEvent(new DragEvent('drop', opts));
      return true;
    } catch (e) { return false; }
  }

  // 附件预览：Gemini 的本地预览图是 blob:/data: 地址（生成图是 https://lh3…，不会混淆）
  const PREVIEW_SEL = 'uploader-file-preview, uploader-file-preview-container, [data-test-id*="file-preview"], [data-test-id*="uploaded"], [data-testid*="file-preview"], [data-testid*="uploaded"], [data-testid*="attachment"], .file-preview, .attachment-preview, .file-chip, .upload-preview, img[src^="blob:"], img[src^="data:image"]';
  const inResponseArea = (el) => !!el.closest(RESP_SELS + ', user-query, .query-content');
  // 本次 uploadFile 开始前输入区已有的预览元素集合：verifyAttachment 据此只认「新增」预览，
  // 上一张残留、未清理掉的旧预览不再误放行（否则会把没附上图的请求直接发出去）
  let lastUploadBefore = new Set();

  async function uploadSettle() {
    // 等上传进度指示消失。范围收窄到输入区（composerRoot）：全文档扫描会被页面上
    // 无关的常驻 spinner 拖满整个超时（每张图白等 120 秒）。选择器不匹配时直接放行，不作为失败条件
    await waitFor(() => {
      const scope = composerRoot() || document;
      return ![...scope.querySelectorAll('mat-progress-spinner, mat-spinner, mat-progress-bar, [role="progressbar"]')]
        .some((p) => isVisible(p));
    }, cfg.uploadTimeoutMs, 800);
    await sleep(1500);
  }

  async function uploadFile(file) {
    const nameKey = (file.name.replace(/\.[^.]+$/, '') || file.name).slice(0, 20);
    // before 集合需包含 composerRoot 内的 img 元素，以便检测改版后新增的预览图
    const cr = composerRoot();
    const before = new Set([
      ...document.querySelectorAll(PREVIEW_SEL),
      ...((cr ? [...cr.querySelectorAll('img')] : []))
    ]);
    lastUploadBefore = before;
    // 附件预览图尺寸下限：Gemini 的图标/按钮 img 通常 < 40px，附件预览缩略图 ≥ 50px
    const PREVIEW_MIN_SIZE = 50;
    const isPreviewImg = (img) => {
      if (!isVisible(img) || panelEl?.contains(img)) return false;
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      return w >= PREVIEW_MIN_SIZE && h >= PREVIEW_MIN_SIZE;
    };
    const attached = () => {
      const r = composerRoot();
      if (r && textHasWholeName(r.textContent, file.name, nameKey)) return true;                 // 出现文件名 chip
      if ([...document.querySelectorAll(PREVIEW_SEL)]                              // 或出现新的预览元素
        .some((el) => !before.has(el) && isVisible(el) && !inResponseArea(el) && !panelEl?.contains(el))) return true;
      // 兜底：检测 composerRoot 内新增的、尺寸足够大的 img 元素（排除小图标）
      if (r) {
        const imgs = [...r.querySelectorAll('img')];
        if (imgs.some((img) => !before.has(img) && isPreviewImg(img))) return true;
      }
      return false;
    };
    // 输入区出现了「本文件名」的 chip —— 比 DOM 预览检测更可靠的附加证据。
    // 优先匹配完整文件名（含扩展名，最精确）；chip 只显示去扩展名文本时退回 nameKey
    const chipAttached = () => {
      const r = composerRoot();
      if (!r) return false;
      const t = r.textContent || '';
      return textHasWholeName(t, file.name, nameKey);
    };

    // 上传途径按「上次成功者优先」排序（记忆存 cfg.uploadPath）：
    // 若页面开始忽略合成 paste/drop（如校验 isTrusted），原顺序会让每张图都在
    // 失效途径上白等满 12 秒×2 才落到 file input（50 张 ≈ 20 分钟纯浪费）
    const pathways = [
      ['paste', async () => {
        // 向编辑器模拟「粘贴」（Gemini 会接管 paste 事件并附加文件）
        return uploadViaPaste(file) && !!(await waitFor(attached, 12000, 500));
      }],
      ['drop', async () => {
        // 模拟拖放（paste 不生效时的备选，Gemini 也处理 drop 事件）
        return uploadViaDrop(file) && !!(await waitFor(attached, 12000, 500));
      }],
      ['input', async () => {
        // 页面上已存在的 file input（优先 accept 含 image 的）
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
          if (await waitFor(attached, 8000, 500)) return true;
        }
        return false;
      }]
    ];
    const memo = cfg.uploadPath;
    if (memo) {
      const mi = pathways.findIndex((p) => p[0] === memo);
      if (mi > 0) pathways.unshift(...pathways.splice(mi, 1));
    }

    const PATH_NAME = { paste: '粘贴', drop: '拖放', input: '文件控件' };
    for (const [name, run] of pathways) {
      if (await run()) {
        await uploadSettle();
        if (cfg.uploadPath !== name) { cfg.uploadPath = name; saveCfg(); }
        log('  ⬆ 已附加（' + PATH_NAME[name] + '方式）：' + file.name);
        return;
      }
      // 本途径可能实际已成功、只是预览 DOM 检测失效（页面改版）：
      // 先看文件名 chip 再换途径，避免把同一张图附加两遍（原实现会继续尝试下一种途径造成重复附件）
      if (chipAttached()) {
        await uploadSettle();
        if (cfg.uploadPath !== name) { cfg.uploadPath = name; saveCfg(); }
        log('  ⬆ 已附加（' + PATH_NAME[name] + '方式，预览检测失效但文件名 chip 已出现）：' + file.name);
        return;
      }
    }

    throw new Error('无法把图片放入输入框（粘贴/拖放/file input 均未检测到附件预览，请点「诊断」反馈）');
  }

  // 发送前最终校验：确认附件确实存在（防止 attached 误判导致只发提示词）。
  // 条件 2/3 只认「本次 uploadFile 之后新增」的预览元素（对照 lastUploadBefore），
  // 上一张未清理干净的残留预览不再误放行——宁可报错重试，也不把没附上图的请求发出去
  function verifyAttachment(nameKey, fullName) {
    const r = composerRoot();
    if (!r) return false;
    const t = r.textContent || '';
    // 条件 1：文件名 chip 出现在输入区（整体匹配）。优先完整文件名（含扩展名），
    // 防「sunset.jpg」的 nameKey「sunset」误匹配残留 chip「sunset-2.jpg」
    if (textHasWholeName(t, fullName, nameKey)) return true;
    const isNew = (el) => !lastUploadBefore.has(el);
    // 条件 2：PREVIEW_SEL 元素存在于 composerRoot 内（限定范围，避免匹配到回复区的残留）
    if ([...r.querySelectorAll(PREVIEW_SEL)].some((el) => isNew(el) && isVisible(el) && !panelEl?.contains(el))) return true;
    // 条件 3：composerRoot 内有 ≥ 50px 的新增预览图
    if ([...r.querySelectorAll('img')].some((img) => isNew(img) && img.naturalWidth >= 50 && img.naturalHeight >= 50 && isVisible(img) && !panelEl?.contains(img))) return true;
    return false;
  }

  async function sendAndWait(qid) {
    const btn = await waitFor(findSendButton, 20000, 400);
    if (!btn) throw new Error('找不到发送按钮');
    // 紧贴点击前一刻快照已存在的回复：后续只把「点发送之后新增」的回复当作本次结果，
    // 防止在当前对话续跑时把历史回复的图下载成当前文件名。快照不能放在找按钮的等待之前——
    // 上一张超时后服务端仍在生成、其迟到回复若在等待窗口内到达，就会漏进快照被误认成本次结果
    const prevEls = new Set(document.querySelectorAll(RESP_SELS));
    const prevCount = prevEls.size;
    // 发送前全页图片 src 快照：回复容器选择器失效（改版）时，无容器兜底收集据此排除
    // 历史回复的图与用户消息里的回显原图（回显图与发送前输入框预览同 blob 地址）
    const prevSrcs = new Set([...document.querySelectorAll('img')]
      .map((im) => im.currentSrc || im.src || '')
      .filter(Boolean));
    btn.click();
    log('  ✉ 已发送，等待生成…');

    // 跨标签页停止/队列替换检测：本标签页停止走 cancelRequested（waitFor 秒级返回），
    // 其他标签页只写 meta.stopped 或换队列 id，这里轮询识别后以 stoppedByOther 中断当前张，
    // 不必等满单张超时（默认 5 分钟）才在循环顶部退出
    const queueGone = () => {
      const cur = metaLoad();
      return !!(cur && (cur.stopped || (qid && cur.id !== qid)));
    };
    const STOP_MARK = { __gicStop: true };
    const stopErr = () => {
      const err = new Error('检测到队列已被停止或替换（其他标签页）');
      err.stoppedByOther = true;
      return err;
    };
    // started 判定兼用身份比对：长对话虚拟滚动下「一旧换一新」总数不变，
    // 仅靠 countResponses() > prevCount 会漏判已开始生成
    const started = await waitFor(() =>
      [...document.querySelectorAll(RESP_SELS)].some((el) => !prevEls.has(el))
      || !!findStopButton() || !sendButtonVisible()
    , 60000, 700);
    if (queueGone()) throw stopErr();
    if (!started) throw new Error('发送后未检测到新回复');

    await sleep(3000); // 等待界面切换到「生成中」状态，避免误判
    // 完成判定加强：除「有发送按钮且无停止按钮」外，还要求页面签名（回复数量、末条回复
    // 文本长度、回复图片地址）连续 4 秒无变化。防止改版后发送按钮不禁用、停止按钮
    // 不出现时过早判完，把仍在生成（>30 秒）的回复误报为「没有生成图片」
    let sig = '', sigAt = 0;
    const pageSig = () => {
      // 签名只统计「本次发送后新增」的回复：虚拟滚动移除旧节点会改变总数，
      // 把旧节点计入会让「页面稳定 4 秒」判定反复归零，最终误报等待超时
      const list = [...document.querySelectorAll(RESP_SELS)].filter((c) => !prevEls.has(c));
      const last = list[list.length - 1];
      const imgSrcs = list.slice(-3)
        .flatMap((c) => [...c.querySelectorAll('img')].map((im) => im.currentSrc || im.src || ''))
        .join('|');
      // 容器选择器失效（改版）时 list 恒为空、签名恒定，「稳定 4 秒」会在发送按钮一恢复
      // 就触发完成判定，而图可能尚未渲染。此时改用全页大图 src 集合参与签名：
      // 生成图渲染进来会使签名变化，稳定计时从图片出现后重新起算
      const allImgSrcs = list.length ? '' : [...document.querySelectorAll('img')]
        .filter((im) => (im.naturalWidth || 0) >= cfg.minImgSize)
        .map((im) => im.currentSrc || im.src || '').join('|');
      return list.length + '|' + (last ? (last.textContent || '').length : 0) + '|' + imgSrcs + '|' + allImgSrcs;
    };
    // 等待期间每 60 秒输出一次心跳日志：长等待不再像卡死，远程排查「卡住」时可直接
    // 看最后日志停在哪个阶段、等待了多久
    const t0Done = Date.now();
    let lastBeat = 0;
    const done = await waitFor(() => {
      if (queueGone()) return STOP_MARK;
      const nowMs = Date.now();
      if (nowMs - lastBeat >= 60000) {
        lastBeat = nowMs;
        log('  ⏳ 仍在等待生成…（已等 ' + Math.round((nowMs - t0Done) / 1000) + ' 秒）');
      }
      if (!sendButtonVisible() || findStopButton()) { sig = ''; sigAt = 0; return false; }
      const s = pageSig();
      if (s !== sig) { sig = s; sigAt = Date.now(); return false; }
      if (!sigAt) { sigAt = Date.now(); return false; }
      return Date.now() - sigAt >= 4000;
    }, cfg.waitTimeoutMs, 1000);
    if (done === STOP_MARK) throw stopErr();
    if (!done) throw new Error('等待生成超时');

    await sleep(2500); // 图片渲染稳定
    let imgs = collectResponseImages(prevCount, prevEls, prevSrcs);
    if (!imgs.length) {
      // 等图的同时监测限额文字（纯文字回复会很快出现，命中即提前结束等待，不用耗满窗口）
      log('  ⏳ 生成图未就绪，继续等待渲染（≤30 秒）…');
      const got = await waitFor(() => {
        if (queueGone()) return STOP_MARK;
        const qt = quotaDetected(prevCount, prevEls);
        if (qt) return { quotaText: qt };
        const v = collectResponseImages(prevCount, prevEls, prevSrcs);
        return v.length ? v : null;
      }, 30000, 1500);
      if (got === STOP_MARK) throw stopErr();
      if (got && got.quotaText) {
        // 带标记的异常：processQueue 识别后不记错误，而是等待额度恢复自动重试
        const err = new Error('检测到用量限额：' + normWs(got.quotaText).slice(0, 60));
        err.quota = true;
        err.quotaText = got.quotaText; // 完整文本：processQueue 尝试从中解析明确的恢复时间
        throw err;
      }
      imgs = got || [];
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
        // 无超时的话，连接挂起（stalled 但未断开）时 Promise 永不 settle：
        // 此时已越过 sendAndWait 的守护、没有任何 waitFor 兜底，队列会永久卡死（心跳照常、锁一直持有）
        timeout: 60000,
        onload: (r) => (r.status >= 200 && r.status < 300) ? resolve(r.response) : reject(new Error('HTTP ' + r.status)),
        onerror: () => reject(new Error('网络或跨域受限')),
        ontimeout: () => reject(new Error('下载超时（60 秒）'))
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

  // 读取 blob/File 的像素尺寸（createImageBitmap 失败返回 null，调用方自行降级）
  async function imageSizeOfBlob(blob) {
    let bm = null;
    try {
      bm = await createImageBitmap(blob);
      const s = { w: bm.width, h: bm.height };
      bm.close();
      return s;
    } catch (e) {
      try { if (bm) bm.close(); } catch (_) {}
      return null;
    }
  }

  // 把图片数据缩放绘制到 w×h 并按 ext 编码（源/目标比例不同即为拉伸）。
  // 采用「先在内存中缩放、再保存」而非「保存后再改」：浏览器脚本无法改写已下载到
  // 下载目录的文件，内存中一次成型保证只落盘一个尺寸正确的文件
  async function resizeBlobTo(blob, w, h, ext) {
    const bm = await createImageBitmap(blob);
    try {
      return await new Promise((resolve, reject) => {
        try {
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          const ctx = c.getContext('2d');
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(bm, 0, 0, w, h);
          c.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas 导出为空'))), MIME_BY_EXT[ext] || 'image/png', 0.95);
        } catch (e) { reject(new Error('canvas 缩放失败（' + ((e && e.name) || e) + '）')); }
      });
    } finally { bm.close(); }
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

  async function downloadImages(imgs, origName, origSize) {
    const p = splitName(origName);
    for (let i = 0; i < imgs.length; i++) {
      const suffix = imgs.length > 1 ? (i === 0 ? '' : '_' + (i + 1)) : '';
      let blob = await fetchImageBlob(imgs[i], p.ext);
      if (!blob || blob.size < 1024) throw new Error('下载的图片数据异常');
      const realExt = blobExt(blob);
      let useExt = p.ext;
      if (realExt && realExt !== p.ext) {
        if (realExt === 'gif') {
          // GIF（可能含动画）不做 canvas 转码（会丢成单帧）：非严格模式扩展名跟随实际数据，
          // 严格模式保留原文件名，但明确提示 .jpg/.png 里装的是 GIF 数据
          if (!cfg.exactName) useExt = 'gif';
          else log('  ⚠ 数据为 GIF（转码会丢动画），严格原名模式下未转码，.' + p.ext + ' 内为 GIF 数据');
        } else if (cfg.exactName && !MIME_BY_EXT[p.ext]) {
          // 严格原名模式下目标是 canvas 无法编码的格式（如 .bmp 原图）：convertBlob 会原样返回，
          // 数据与扩展名名实不符。明确提示而不是静默存错（非严格模式走下方 else，扩展名跟随实际数据）
          log('  ⚠ 无法转码为 ' + p.ext.toUpperCase() + '（浏览器 canvas 不支持编码该格式），按原始 ' + realExt.toUpperCase() + ' 数据保存为 .' + p.ext);
        } else if (cfg.exactName) {
          // 严格原文件名：把数据转成扩展名对应的格式，而不是把 PNG 数据存成 .jpg
          try { blob = await convertBlob(blob, p.ext); log('  🔁 已将 ' + realExt.toUpperCase() + ' 转为 ' + p.ext.toUpperCase()); }
          catch (e) { log('  ⚠ 格式转换失败，按原始 ' + realExt.toUpperCase() + ' 数据保存为 .' + p.ext); }
        } else {
          useExt = realExt;
        }
      }
      // 尺寸对齐原图：Gemini 输出的分辨率常与原图不同，保存前在内存中缩放到与原图一致。
      // GIF 不缩放（canvas 转码会丢动画）；目标格式 canvas 无法编码（如 .bmp）时跳过；
      // 缩放失败按生成图原始尺寸保存，不中断队列
      if (cfg.matchSize && origSize && realExt !== 'gif' && MIME_BY_EXT[useExt]) {
        const sz = await imageSizeOfBlob(blob);
        if (sz && (sz.w !== origSize.w || sz.h !== origSize.h)) {
          if (Math.abs(sz.w / sz.h - origSize.w / origSize.h) > 0.02) {
            log('  ⚠ 生成图 ' + sz.w + '×' + sz.h + ' 与原图 ' + origSize.w + '×' + origSize.h + ' 比例不同，将拉伸对齐');
          }
          try {
            blob = await resizeBlobTo(blob, origSize.w, origSize.h, useExt);
            log('  📐 已缩放至原图尺寸 ' + origSize.w + '×' + origSize.h);
          } catch (e) { log('  ⚠ 尺寸对齐失败，按生成图原始尺寸保存：' + ((e && e.message) || e)); }
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
    // 同名去重：不同子文件夹里的同名文件（a/1.jpg、b/1.jpg）下载时会互相覆盖，追加序号区分
    const seen = Object.create(null);
    const names = files.map((f) => {
      const k = f.name.toLowerCase();
      seen[k] = (seen[k] || 0) + 1;
      if (seen[k] === 1) return f.name;
      const p = splitName(f.name);
      return p.base + ' (' + seen[k] + ').' + p.ext;
    });
    const meta = {
      id: TAB_ID + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), // 队列代 ID：防止旧标签页的过期快照覆盖新队列（见 processQueue）
      prompt: String(prompt).trim(),
      names: names,
      statuses: names.map(() => 'pending'),
      errors: {},
      idx: 0,
      done: false
    };
    // 顺序：先清扫上一轮越界残留 → 再写文件 → 最后写 meta。
    // 若先写 meta 后写文件，两步之间崩溃会留下「有队列无文件」的半启动状态（第一张就报文件数据丢失）
    await fileSweep(files.length);
    for (let i = 0; i < files.length; i++) await fileSet(i, files[i]);
    metaSave(meta);
    log('🚀 新任务：' + names.length + ' 张图片，提示词：' + meta.prompt);
    updatePanelState();
    processQueue();
  }

  async function processOne(i, prompt, name, qid) {
    const file = await fileGet(i);
    if (!file) throw new Error('文件数据丢失，请重新发起任务');
    await clearEditor();
    await uploadFile(file);
    // 发送前最终校验：确认附件确实存在，防止 attached 误判导致只发提示词
    const nameKey = (file.name.replace(/\.[^.]+$/, '') || file.name).slice(0, 20);
    if (!verifyAttachment(nameKey, file.name)) {
      throw new Error('附件校验失败：图片未真正附加到输入框（请点「诊断」反馈）');
    }
    await setPrompt(prompt);
    const imgs = await sendAndWait(qid);
    // 原图尺寸只在需要时解码一次（尺寸对齐关闭时零开销）
    let origSize = null;
    if (cfg.matchSize) {
      origSize = await imageSizeOfBlob(file);
      if (!origSize) log('  ⚠ 无法读取原图尺寸，跳过尺寸对齐');
    }
    await downloadImages(imgs, name, origSize);
  }

  async function processQueue() {
    if (localRunning) return;
    const m = metaLoad();
    if (!m || m.done || m.stopped) return;
    if (!tryAcquireLock()) { log('⏸ 其他标签页正在处理队列'); return; }
    localRunning = true; // 立即置位：防止下面的锁复核等待期间本标签页重入
    cancelRequested = false;
    const qid = m.id; // 队列代 ID：循环内各检查点据此识别「队列被替换」，finally 据此做收尾交接
    let hb = null;
    try {
      // 锁竞态兜底：两个标签页同一毫秒双双获锁时，后写者的心跳会在 ~250ms 后独占锁，先写者在此退出
      await sleep(250);
      if (!lockHeldByMe()) { log('⏸ 锁已被其他标签页取得（竞争或已停止），本标签页退出'); return; }
      heartbeat();
      hb = setInterval(heartbeat, 5000);
      panelShow();
      renderList(m);
      const ready = await waitFor(() => !!getEditor() && !!composerRoot(), 45000, 600);
      if (!ready) { log('⚠ 页面输入框未就绪；刷新页面后会自动续跑'); return; }

      // 每张开始前校验队列仍是本队列（未被停止/替换）。队列被替换的典型场景：
      // 其他标签页「停止后重新发起」或「重置后重新发起」新队列（meta 已换新 id）
      for (let i = m.idx; i < m.names.length; i++) {
        const cur = metaLoad();
        if (!cur || cur.done || cur.stopped || cur.id !== qid) { log('⏹ 队列已被停止或替换'); return; }
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
          await processOne(i, m.prompt, m.names[i], qid);
          m.statuses[i] = 'ok';
          panelSetState(m, i, 'ok');
          log('✅ ' + m.names[i]);
        } catch (e) {
          // 被用户停止时（本标签页 cancelRequested，或其他标签页停止/替换队列触发的
          // stoppedByOther 中断），当前图片回退为 pending（不标记为错误），以便续跑
          if (cancelRequested || (e && e.stoppedByOther)) {
            m.statuses[i] = 'pending';
            const cur2 = metaLoad();
            if (!cur2 || cur2.id === qid) {
              m.stopped = true; // stopQueue 已写 stopped=true，但 m 是循环开始时加载的快照，需补上再保存
              metaSave(m);
              log('⏹ 已停止，当前图片未完成（点「执行」可继续）');
            } else {
              log('⏹ 已停止（队列已被其他标签页替换，放弃保存旧快照）');
            }
            return;
          }
          // 用量限额：不记错误，当前张回退 pending，等待额度恢复后自动重试
          if (e && e.quota) {
            // 保存前的防护与循环底部一致：队列被其他标签页替换 → 不保存直接退出；
            // 被其他标签页停止 → 合并停止标志（否则等待后无视停止继续跑）
            const curQ = metaLoad();
            if (curQ && curQ.id !== qid) { log('⏹ 队列已被其他标签页替换，放弃限额等待'); return; }
            if (curQ && curQ.stopped) m.stopped = true;
            m.statuses[i] = 'pending';
            m.idx = i; // 当前张未完成，断点保持在本张（刷新续跑也从此张重新开始）
            metaSave(m);
            if (m.stopped) {
              log('⏹ 队列已停止，不再等待额度恢复（点「执行」可从该张继续）');
              return;
            }
            // 「查看用量」页的当前用量重置时间优先级最高：聊天页的限额提示有时
            // 不带时间，或显示出与用量页不同的时刻。没有缓存时才解析回复/使用兜底间隔。
            let waitMs = usageResetWaitMs();
            let waitSrc = waitMs ? '查看用量页' : null;
            if (!waitMs) {
              waitMs = parseQuotaWaitMs(e && e.quotaText);
              waitSrc = waitMs ? '回复中解析' : null;
            }
            if (!waitMs) {
              waitMs = cfg.quotaRetryMs;
              if (typeof waitMs !== 'number' || !(waitMs >= 60000)) waitMs = 30 * 60 * 1000;
              waitSrc = '设定间隔（回复未含明确时间）';
            }
            panelSetState(m, i, 'quota');
            log('⏰ ' + ((e && e.message) || e));
            log('⏳ 等待额度恢复（' + waitSrc + '）：' + fmtDur(waitMs) + '后自动重试'
              + '（预计 ' + new Date(Date.now() + waitMs).toLocaleTimeString('zh-CN', { hour12: false })
              + '，点「停止」可中断）');
            toast('用量限额：' + fmtDur(waitMs) + '后自动重试', 6000);
            // 分段等待：用户在等待期间打开「查看用量」页后，观察器会缓存真实时刻，
            // 下一次 5 秒轮询立即改按该时刻等待，无须把原先的固定间隔等完。
            if (!(await waitForQuotaRetry(qid, waitMs))) return;
            i--; // 抵消 for 的 i++，重试当前张
            continue;
          }
          m.statuses[i] = 'err';
          m.errors = m.errors || {};
          m.errors[i] = String((e && e.message) || e);
          panelSetState(m, i, 'err');
          log('❌ ' + m.names[i] + '：' + m.errors[i]);
        }
        m.idx = i + 1;
        // 保存前的双重同步（m 是循环开始时的快照）：
        //  1. 队列已被其他标签页替换（id 不一致）→ 立即退出，绝不能用旧快照覆盖新队列
        //  2. stopQueue 可能在 processOne 的不可中断段（如 downloadImages）期间写入 stopped=true，
        //     无论停止来自本标签页（cancelRequested）还是其他标签页（存储里的 stopped），都要合并进快照，
        //     否则保存会覆盖停止标志导致队列不停
        const cur2 = metaLoad();
        if (cur2 && cur2.id !== qid) { log('⏹ 队列已被其他标签页替换，本标签页退出'); return; }
        if (cancelRequested) m.stopped = true;
        else if (!m.stopped && cur2 && cur2.stopped) m.stopped = true;
        metaSave(m);
        await fileDel(i);
        await sleep(1200);
      }

      const cur2 = metaLoad();
      if (cur2 && cur2.id !== qid) { log('⏹ 队列已被其他标签页替换，跳过完成标记'); return; }
      const okN = m.statuses.filter((s) => s === 'ok').length;
      const errN = m.statuses.filter((s) => s === 'err').length;
      m.done = true;
      metaSave(m);
      log('🎉 队列完成：成功 ' + okN + '，失败 ' + errN);
      toast('全部处理完成：成功 ' + okN + '，失败 ' + errN, 5000);
    } catch (e) {
      // 顶层兜底：per-item try 覆盖不到的异常（如 renderList/panelShow 的 DOM 错误）。
      // processQueue 的调用点（startRun/executeClick/boot/finally 交接）全部 fire-and-forget 不 await，
      // 没有它的话异常以未处理 rejection 逃逸，UI 表现为「无声停止」且无任何日志。
      // 当前项在磁盘上仍是 pending（busy 只写内存），刷新后 boot 的自动续跑会重试该张
      try { log('❌ 队列异常终止：' + ((e && e.message) || e)); } catch (_) {}
      try { toast('队列异常终止：' + ((e && e.message) || e), 6000); } catch (_) {}
    } finally {
      if (hb) clearInterval(hb);
      localRunning = false;
      cancelRequested = false;
      releaseLock();
      updatePanelState();
      // 收尾交接：退出期间若出现了新的待处理队列（重置后立即「执行」等场景——
      // 新的 processQueue 调用会因 localRunning 尚为 true 被挡住而挂起，等刷新才续跑），
      // 此处自动接手。锁竞争失败/队列已停止或完成时不会触发，无自旋风险
      try {
        const m2 = metaLoad();
        if (m2 && !m2.done && !m2.stopped && m2.id !== qid) processQueue();
      } catch (e) { /* 忽略 */ }
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

  /* ---- 重置：清除队列与已选文件（保留提示词、选项、记住的文件夹） ---- */
  let resetArmed = false;
  let resetTimer = null;

  function resetBtnUi(on) {
    if (!resetBtn) return;
    resetBtn.textContent = on ? '⚠ 确认重置？' : '🗑 重置';
    resetBtn.style.background = on ? '#5d4037' : '#2a2b2f';
    resetBtn.style.color = on ? '#f28b82' : '#9aa0a6';
  }

  // 两步确认：第一次点击进入待确认状态（按钮变红 4 秒），再点一次才真正重置，防误触
  function resetBtnClick() {
    if (resetArmed) {
      clearTimeout(resetTimer);
      resetArmed = false;
      resetBtnUi(false);
      doReset();
      return;
    }
    resetArmed = true;
    resetBtnUi(true);
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => { resetArmed = false; resetBtnUi(false); }, 4000);
  }

  async function doReset() {
    // 1) 写入墓碑 meta：id 与任何运行中队列都不同 → 各标签页的 processQueue 在下一检查点
    //    识别出「队列已被替换」而退出，且不会用旧快照回写存储（不会复活已重置的队列）；
    //    done=true 让面板立刻回到空闲态（执行按钮可用）
    metaSave({
      id: 'reset-' + Date.now().toString(36),
      prompt: '', names: [], statuses: [], errors: {}, idx: 0,
      done: true, stopped: false
    });
    // 2) 中断本标签页正在执行的循环（waitFor 秒级返回；不可中断段结束后也会在检查点退出）
    if (localRunning) cancelRequested = true;
    // 3) 删除 IndexedDB 里所有排队文件（file:*）
    await fileSweep(0);
    // 4) 清除本次会话的已选文件与日志显示
    pickedFiles = null;
    pickedLabel = '';
    logLines.length = 0;
    try {
      const list = panelEl && panelEl.querySelector('.gicp-list');
      if (list) list.textContent = '';
      const logEl = panelEl && panelEl.querySelector('.gicp-log');
      if (logEl) logEl.textContent = '';
    } catch (e) { /* 忽略 */ }
    // 5) 锁若在本标签页手中则释放（正在收尾的循环其 finally 也会释放，二者幂等）
    releaseLock();
    updatePanelState();
    log('🗑 已重置：队列与已选文件已清除（提示词、选项、记住的文件夹保留）');
    toast('已重置（提示词、选项、记住的文件夹保留）', 5000);
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

      let done = false, blurred = false, refocusAt = 0;
      const t0 = Date.now();
      const finish = (v) => {
        if (done) return;
        done = true;
        clearInterval(poll);
        window.removeEventListener('blur', onBlur);
        try { inp.remove(); } catch (e) {}
        resolve(v);
      };
      const onBlur = () => { blurred = true; };
      window.addEventListener('blur', onBlur);
      // 弹窗检测轮询：
      //  - macOS 等平台的系统对话框不一定触发 window blur，用 document.hasFocus() 兜底
      //    判定「对话框已打开」，避免真实弹出的选择框被误判为被拦截、又叠加按钮面板（双重弹窗）
      //  - 3 秒内既无失焦迹象也未被取消 → 判定被浏览器拦截
      //  - 对话框关闭（焦点回来）后 800ms 内没有 change 事件 → 视为用户取消
      const poll = setInterval(() => {
        if (done) return;
        if (!blurred && !document.hasFocus()) blurred = true; // 不触发 blur 事件的平台兜底
        if (blurred) {
          if (document.hasFocus()) {
            if (!refocusAt) refocusAt = Date.now();
            else if (Date.now() - refocusAt > 800) finish({ files: [] });
          } else {
            refocusAt = 0;
          }
        } else if (Date.now() - t0 > 3000) {
          finish({ blocked: true });
        }
      }, 400);

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
  let folderLabelEl = null, promptBox = null, runBtn = null, stopBtn = null, resetBtn = null;
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

    // 恢复上次拖动位置（面板被页面移除重建、或刷新后不再跳回默认位置；钳制在视口内防止移到屏幕外）
    try {
      const pos = JSON.parse(localStorage.getItem('gic-panel-pos') || 'null');
      if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
        panelEl.style.left = Math.max(0, Math.min(pos.left, Math.max(0, window.innerWidth - 120))) + 'px';
        panelEl.style.top = Math.max(0, Math.min(pos.top, Math.max(0, window.innerHeight - 80))) + 'px';
        panelEl.style.right = 'auto';
        panelEl.style.bottom = 'auto';
      }
    } catch (e) { /* 位置恢复失败不影响功能 */ }

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
    const cb3 = makeCheckbox('尺寸对齐原图', cfg.matchSize, (v) => { cfg.matchSize = v; saveCfg(); });
    cb3.title = '生成图与原图尺寸不同时，保存前自动缩放为原图尺寸（比例不同会拉伸；GIF 不处理）';
    row3.appendChild(cb1);
    row3.appendChild(cb2);
    row3.appendChild(cb3);
    // 限额重试间隔（分钟）：检测到用量限额后每隔多久自动重试
    const quotaWrap = document.createElement('label');
    quotaWrap.title = '检测到用量限额后，优先使用「查看用量」页同步的真实重置时间；未获取时按此间隔重试';
    quotaWrap.style.cssText = 'display:flex;align-items:center;gap:4px;cursor:pointer';
    const quotaInput = document.createElement('input');
    quotaInput.type = 'number';
    quotaInput.min = '1';
    quotaInput.max = '1440';
    quotaInput.value = String(Math.max(1, Math.round(((typeof cfg.quotaRetryMs === 'number' && cfg.quotaRetryMs) || 30 * 60 * 1000) / 60000)));
    quotaInput.style.cssText = 'width:52px;background:#141517;color:#e3e3e3;border:1px solid #3c4043;border-radius:6px;padding:3px 6px;font-size:11px';
    quotaInput.addEventListener('change', () => {
      let v = parseInt(quotaInput.value, 10);
      if (!Number.isFinite(v) || v < 1) v = 30;
      if (v > 1440) v = 1440;
      quotaInput.value = String(v);
      cfg.quotaRetryMs = v * 60 * 1000;
      saveCfg();
    });
    const quotaSpan = document.createElement('span');
    quotaSpan.textContent = '限额等待(分)';
    quotaWrap.appendChild(quotaInput);
    quotaWrap.appendChild(quotaSpan);
    row3.appendChild(quotaWrap);
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
    resetBtn = document.createElement('button');
    resetBtn.textContent = '🗑 重置';
    resetBtn.title = '清除当前队列与已选文件（提示词、选项、记住的文件夹保留）';
    resetBtn.style.cssText = 'background:#2a2b2f;color:#9aa0a6;border:1px solid #3c4043;border-radius:8px;padding:9px 10px;font-size:12px;cursor:pointer';
    resetBtn.addEventListener('click', resetBtnClick);
    row4.appendChild(runBtn);
    row4.appendChild(stopBtn);
    row4.appendChild(diagBtn);
    row4.appendChild(resetBtn);
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

    // 面板拖动：mousemove/mouseup 只在拖动期间挂载、松手即摘除。
    // 原实现挂在 window 上永不移除，面板被页面移除重建后监听器（闭包持有旧状态）会无限累积
    head.addEventListener('mousedown', (ev) => {
      if (ev.target.closest && ev.target.closest('button')) return; // 点标题栏上的按钮（如 ×）不触发拖动
      const sx = ev.clientX, sy = ev.clientY;
      const r = panelEl.getBoundingClientRect();
      const ox = r.left, oy = r.top;
      ev.preventDefault();
      const onMove = (e) => {
        panelEl.style.left = Math.max(0, ox + e.clientX - sx) + 'px';
        panelEl.style.top = Math.max(0, oy + e.clientY - sy) + 'px';
        panelEl.style.right = 'auto';
        panelEl.style.bottom = 'auto';
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        // 持久化拖动位置，页面移除重建面板/刷新后可恢复
        try { localStorage.setItem('gic-panel-pos', JSON.stringify({ left: panelEl.offsetLeft, top: panelEl.offsetTop })); } catch (e) {}
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });

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
    // 未完成状态含 'quota'（限额等待中被停止的项），否则停止后无法续跑
    const hasPending = stopped && m.statuses.some((s) => s === 'pending' || s === 'quota');
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
      // 原生 API 的 paths 不含根目录名（walkDir 前缀为空），paths[0].split('/')[0] 会取到
      // 排序后第一个文件名；优先用目录句柄的 name，只有 input 控件路径才回退解析
      const folderName = (r.handle && r.handle.name) || String(r.paths[0] || '').split('/')[0] || '(未知)';
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
      // 未完成状态含 'quota'（限额等待中被停止的项），否则该张会被静默丢弃
      const hasPending = q.statuses.some((s) => s === 'pending' || s === 'quota');
      if (hasPending) {
        // 防竞态：上一个 processQueue 可能尚未退出（localRunning 仍为 true），
        // 此时调用 processQueue 会被 guard 拦住直接返回，导致队列卡死
        if (localRunning) {
          toast('队列正在停止中，请稍候再点「继续」');
          return;
        }
        // 续跑沿用队列发起时的提示词，面板里改过的不生效——明确告知，避免静默误解
        const curPrompt = (promptBox ? promptBox.value : cfg.defaultPrompt || '').trim();
        if (curPrompt && curPrompt !== q.prompt) {
          log('⚠ 续跑使用队列发起时的提示词（面板修改不生效）：' + q.prompt);
          toast('续跑仍使用原提示词（面板修改不生效）', 5000);
        }
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
    // startRun 会批量写 IndexedDB，可能因配额等 reject；不 catch 的话点击表现为无响应（未处理的 promise rejection）
    try {
      await startRun(files, prompt);
    } catch (e) {
      log('❌ 发起任务失败：' + ((e && e.message) || e));
      toast('发起任务失败：' + ((e && e.message) || e), 6000);
    }
  }

  /* ---- 进度列表 / 日志 ---- */
  function renderList(m) {
    if (!panelEl || !m) return;
    const list = panelEl.querySelector('.gicp-list');
    if (!list) return;
    const icons = { pending: '⏸', busy: '⏳', ok: '✅', err: '❌', quota: '⏰' };
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
    // SCRIPT_VERSION 已在加载时从 GM_info 同步（无沙箱环境回退字面量），无需重复读取
    lines.push('脚本版本：' + SCRIPT_VERSION);
    const resetAt = Number(cfg.quotaResetAt);
    const resetWait = usageResetWaitMs();
    lines.push('查看用量重置时间缓存：' + (resetWait
      ? '✅ ' + new Date(resetAt).toLocaleString('zh-CN', { hour12: false })
      : '未获取或已过期'));
    lines.push('限额等待截止时间：' + (quotaRetryAt
      ? new Date(quotaRetryAt).toLocaleString('zh-CN', { hour12: false }) : '当前未在限额等待'));
    const queueState = metaLoad();
    lines.push('队列状态：' + (!queueState || queueState.done ? '已完成或无队列'
      : queueState.stopped ? '已停止' : localRunning ? '本标签页执行中' : '等待执行或由其他标签页执行'));
    const ed = getEditor();
    const allEds = document.querySelectorAll(EDITOR_SELS.join(','));
    const sb = findSendButton();
    const ncb = tryFindNewChatButton();
    const respN = countResponses();
    // 关键元素一行汇总放最前：反馈内容即使被截断，首行也带着结论
    lines.push('关键元素汇总：输入框' + (ed ? '✅' : '❌')
      + ' | 发送按钮' + (sb ? '✅' : '❌')
      + ' | 新对话按钮' + (ncb ? '✅' : '❌')
      + ' | 回复容器' + (respN ? '✅(' + respN + ')' : '❌(0)'));
    lines.push('文件夹选择方式：' + (typeof window.showDirectoryPicker === 'function' ? '原生 API ✅' : '上传控件（兜底）'));
    lines.push('userActivation：' + (navigator.userActivation ? '支持' : '不支持（旧浏览器）'));
    lines.push('输入框：' + (ed ? '✅ ' + describeEl(ed) : '❌ 未找到') + '（候选 ' + allEds.length + ' 个，可见 ' + [...allEds].filter(isVisible).length + ' 个）');
    const cr = composerRoot();
    lines.push('输入区容器：' + (cr ? '✅ ' + describeEl(cr) : '❌ 未找到'));
    const rawSend = document.querySelectorAll('button.send-button').length;
    lines.push('发送按钮：' + (sb ? '✅ ' + (sb.getAttribute('aria-label') || describeEl(sb)) : '❌ 未找到（button.send-button 原始匹配 ' + rawSend + ' 个；>0 = 按钮在但被禁用/隐藏，如输入框为空时属正常）'));
    // 输入区按钮清单：发送键改版时，这里的 label/icon/位置直接给出新标记
    if (cr) {
      const cbs = [...cr.querySelectorAll('button, [role="button"]')];
      lines.push('输入区按钮：' + cbs.length + ' 个');
      cbs.slice(0, 12).forEach((b, idx) => {
        const r = b.getBoundingClientRect();
        const icon = [...b.querySelectorAll('mat-icon, .material-symbols-outlined, [fonticon]')]
          .map((ic) => (ic.textContent || ic.getAttribute('fonticon') || '').trim()).filter(Boolean).join('/');
        const label = ((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('mattooltip') || '')).trim();
        lines.push('  - #' + idx + (b.disabled ? ' [禁用]' : '') + (r.width ? '' : ' [隐藏]')
          + ' label="' + (label || '(无)') + '" icon="' + (icon || '(无)') + '" x=' + Math.round(r.left) + ' w=' + Math.round(r.width));
      });
    }
    lines.push('新对话按钮：' + (ncb ? '✅ ' + (ncb.getAttribute('aria-label') || (ncb.textContent || '').trim().slice(0, 20)) : '❌ 未找到'));
    const inputs = [...document.querySelectorAll('input[type="file"]')];
    lines.push('文件输入框：' + inputs.length + ' 个');
    lines.push('附件预览元素（blob 图/预览组件）：' + [...document.querySelectorAll(PREVIEW_SEL)].filter((el) => isVisible(el) && !inResponseArea(el)).length + ' 个');
    inputs.slice(0, 3).forEach((i) => lines.push('  - accept=' + (i.accept || '(空)')));
    lines.push('回复容器数量：' + respN);
    // 容器候选计数：主选择器归零（改版）时，哪个候选仍有计数，新容器的名字就是哪个
    const respCandidates = ['model-response', 'response-container', 'message-content', 'chat-window', 'conversation-container', '.model-response-text', '.response-container-content'];
    lines.push('回复容器候选计数：' + respCandidates.map((s) => s + '=' + document.querySelectorAll(s).length).join('，'));
    // 大图按所在区域归类：「未识别区域」占比高即说明回复容器结构变了（改版）
    const bigImgs = [...document.querySelectorAll('img')].filter((i) => (i.naturalWidth || 0) >= cfg.minImgSize);
    const imgCtx = (im) => inComposer(im) ? '输入框'
      : im.closest('user-query, .query-content, [data-test-id*="query"]') ? '用户消息'
      : im.closest(RESP_SELS) ? '回复区' : '未识别区域⚠';
    const ctxCount = {};
    bigImgs.forEach((im) => { const c = imgCtx(im); ctxCount[c] = (ctxCount[c] || 0) + 1; });
    lines.push('页面大图（≥' + cfg.minImgSize + 'px）：' + bigImgs.length + ' 张'
      + (bigImgs.length ? '（' + Object.keys(ctxCount).map((k) => k + ' ' + ctxCount[k]).join(' / ') + '）' : ''));
    bigImgs.slice(-5).forEach((i) => {
      const src = String(i.currentSrc || i.src || '');
      lines.push('  - [' + imgCtx(i) + '|' + (src.split(':')[0] || '?') + '] ' + i.naturalWidth + '×' + i.naturalHeight + ' ' + src.slice(0, 70));
    });
    const msg = lines.join('\n')
      + '\n\n提示：若关键元素为 ❌，说明 Google 改了页面结构。\n请点「📋 一键复制」把全文发给维护者（文字可直接据此改代码，比截图有用），以便更新选择器。';
    log('诊断完成');
    showDiagDialog(msg);
  }

  /* ---- 诊断结果弹窗（一键复制）：alert 无法选中复制，改为 textarea + 复制按钮 ---- */
  function showDiagDialog(msg) {
    const mask = document.createElement('div');
    mask.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box';
    const box = document.createElement('div');
    box.style.cssText = 'background:#1e1f22;color:#e3e3e3;border:1px solid #3c4043;border-radius:12px;padding:16px 18px;width:520px;max-width:94vw;max-height:86vh;display:flex;flex-direction:column;box-shadow:0 6px 24px rgba(0,0,0,.45);font:13px/1.6 system-ui,sans-serif;box-sizing:border-box';
    const head = document.createElement('div');
    head.style.cssText = 'font-weight:600;margin-bottom:8px';
    head.textContent = '🔍 诊断结果（v' + SCRIPT_VERSION + '）';
    const ta = document.createElement('textarea');
    ta.value = msg;
    ta.readOnly = true;
    ta.spellcheck = false;
    ta.style.cssText = 'flex:1;min-height:220px;width:100%;box-sizing:border-box;background:#141517;color:#bdc1c6;border:1px solid #3c4043;border-radius:8px;padding:8px 10px;font:11px/1.6 Consolas,Menlo,monospace;resize:vertical';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;margin-top:10px;align-items:center';
    const copyBtn = document.createElement('button');
    copyBtn.textContent = '📋 一键复制';
    copyBtn.style.cssText = 'background:#8ab4f8;color:#202124;border:0;border-radius:8px;padding:8px 18px;font-size:13px;font-weight:600;cursor:pointer';
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '关闭';
    closeBtn.style.cssText = 'background:#2a2b2f;color:#9aa0a6;border:1px solid #3c4043;border-radius:8px;padding:8px 14px;font-size:12px;cursor:pointer';
    const tip = document.createElement('span');
    tip.style.cssText = 'color:#9aa0a6;font-size:11px;margin-left:auto';
    tip.textContent = '复制后粘贴发给维护者';
    row.appendChild(copyBtn); row.appendChild(closeBtn); row.appendChild(tip);
    box.appendChild(head); box.appendChild(ta); box.appendChild(row);
    mask.appendChild(box);
    (document.body || document.documentElement).appendChild(mask);

    const close = () => { try { mask.remove(); } catch (e) {} };
    closeBtn.addEventListener('click', close);
    mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
    copyBtn.addEventListener('click', async () => {
      const ok = await copyText(msg, ta);
      copyBtn.textContent = ok ? '✅ 已复制' : '⚠ 复制失败，请在框内手动全选复制';
      copyBtn.style.background = ok ? '#81c995' : '#f28b82';
      setTimeout(() => { copyBtn.textContent = '📋 一键复制'; copyBtn.style.background = '#8ab4f8'; }, 2500);
    });
  }

  // 复制文本：剪贴板 API 优先（https + 用户手势内可用）；失败回退 execCommand
  // （readonly textarea 仍可 select + copy，作为非安全上下文/权限受限时的兜底）
  async function copyText(text, ta) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) { /* 走回退 */ }
    try {
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, text.length);
      return document.execCommand('copy');
    } catch (e) { return false; }
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
    GM_registerMenuCommand('🗑 重置队列与选择', () => {
      if (window.confirm('重置将清除当前队列与本次已选文件（提示词、选项、记住的文件夹会保留）。\n确定重置？')) doReset();
    });
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
      // 用户点 Gemini 的「查看用量」后，同页脚本会读取“当前用量”的真实重置时刻并缓存；
      // 回到对话页遇到限额时即可直接按该时刻等待。
      watchUsageResetTime();
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
