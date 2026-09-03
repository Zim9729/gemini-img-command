// ==UserScript==
// @name         Gemini 图片生成命令 (/img)
// @namespace    gemini-img-command
// @version      1.1.0
// @description  在 gemini.google.com 输入 /img 或 /imgf（整文件夹批量）：自动选图上传 → 发送 → 等待生成 → 按原图文件名下载。支持多图排队、每图独立新对话、断点续跑、诊断工具。
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
 *  Gemini 图片生成命令
 *
 *  在 gemini.google.com 的输入框里输入命令并回车，即可触发全自动流程：
 *      /img 把画面改成下雪的冬天
 *  → 弹出文件选择框（可多选）
 *  → 逐张：自动上传图片 → 填入提示词 → 点击发送 → 等待生成完成
 *  → 下载生成图，文件名与上传的原图完全一致
 *
 *  命令列表（/imghelp 可查看）：
 *      /img <提示词>    选图并执行（提示词可省略，用默认）
 *      /imgf <提示词>   选择整个文件夹，自动批量处理其中所有图片
 *      /imgset <提示词> 设置默认提示词
 *      /imgconf         切换「每张图新开对话」
 *      /imgname         切换「严格原名 / 自动纠正扩展名」
 *      /imgclear        停止并清除当前队列
 *      /imgdiag         诊断页面元素（Google 改版后排查用）
 *      /imghelp         显示帮助
 *  其他入口：Alt+G（选图）/ Alt+F（选文件夹）/ Tampermonkey 菜单命令
 * ────────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  /* ============================================================
   * 一、配置
   * ============================================================ */
  const DEFAULT_CFG = {
    defaultPrompt: '',             // 默认提示词（/img 不带参数时使用）
    newChatPerImage: true,         // 每张图新开一个对话
    exactName: true,               // 严格使用原文件名（不做扩展名纠正）
    waitTimeoutMs: 300 * 1000,     // 单张图等待生成的超时（5 分钟）
    uploadTimeoutMs: 120 * 1000,   // 等待附件上传完成的超时（2 分钟）
    minImgSize: 200,               // 判定为「生成图」的最小宽度(px)
  };

  function safeParse(s) {
    try { return JSON.parse(s) || {}; } catch (e) { return {}; }
  }
  let cfg = Object.assign({}, DEFAULT_CFG, safeParse(GM_getValue('cfg', '{}')));
  function saveCfg() { GM_setValue('cfg', JSON.stringify(cfg)); }

  /* ============================================================
   * 二、基础工具
   * ============================================================ */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

  function waitFor(fn, timeout, step) {
    step = step || 500;
    return new Promise((resolve) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        let v = null;
        try { v = fn(); } catch (e) { v = null; }
        if (v) { clearInterval(timer); resolve(v); }
        else if (Date.now() - t0 >= timeout) { clearInterval(timer); resolve(null); }
      }, step);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
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

  /* ---- 多标签页互斥锁（localStorage，心跳保活） ---- */
  const TAB_ID = Math.random().toString(36).slice(2);

  function lockInfo() {
    try { return JSON.parse(localStorage.getItem('gic-lock') || 'null'); } catch (e) { return null; }
  }
  function navRecent() {
    const t = Number(localStorage.getItem('gic-nav') || 0);
    return !!t && Date.now() - t < 60000;
  }
  function tryAcquireLock() {
    const lk = lockInfo();
    // 其他标签页心跳新鲜且不是我们主动导航过来的 → 不抢
    if (lk && lk.tab !== TAB_ID && Date.now() - lk.ts < 15000 && !navRecent()) return false;
    try { localStorage.removeItem('gic-nav'); } catch (e) {}
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
   * 四、浮动状态面板
   * ============================================================ */
  let panelEl = null;
  const logLines = [];

  function ensurePanel() {
    if (panelEl && panelEl.isConnected) return panelEl;
    if (panelEl) panelEl.remove();
    panelEl = document.createElement('div');
    panelEl.style.cssText = [
      'position:fixed', 'right:20px', 'bottom:20px', 'z-index:2147483646',
      'width:330px', 'max-height:420px', 'display:none', 'flex-direction:column',
      'background:#1e1f22', 'color:#e3e3e3', 'font:12px/1.6 system-ui,sans-serif',
      'border:1px solid #3c4043', 'border-radius:10px',
      'box-shadow:0 6px 24px rgba(0,0,0,.45)', 'overflow:hidden'
    ].join(';');

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;background:#2a2b2f;cursor:move;user-select:none;font-weight:600';
    head.textContent = 'Gemini /img 命令';
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.title = '隐藏面板（任务仍在后台执行）';
    closeBtn.style.cssText = 'margin-left:auto;background:none;border:0;color:#9aa0a6;cursor:pointer;font-size:15px;line-height:1';
    closeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      panelEl.style.display = 'none';
    });
    head.appendChild(closeBtn);

    const body = document.createElement('div');
    body.style.cssText = 'padding:8px 10px;overflow:auto';
    const list = document.createElement('div');
    list.className = 'gicp-list';
    const logEl = document.createElement('div');
    logEl.className = 'gicp-log';
    logEl.style.cssText = 'margin-top:6px;white-space:pre-wrap;color:#bdc1c6;font-family:Consolas,Menlo,monospace;font-size:11px;max-height:180px;overflow:auto';
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

  function panelShow(m) {
    const p = ensurePanel();
    p.style.display = 'flex';
    if (m) renderList(m);
  }

  function renderList(m) {
    if (!panelEl || !m) return;
    const list = panelEl.querySelector('.gicp-list');
    if (!list) return;
    const icons = { pending: '⏸', busy: '⏳', ok: '✅', err: '❌' };
    let html = m.names.map((n, i) => {
      const st = m.statuses[i] || 'pending';
      const err = m.errors && m.errors[i];
      return '<div>【' + (icons[st] || '⏸') + '】' + (i + 1) + '. ' + escapeHtml(n) +
        (st === 'err' && err ? ' <span style="color:#f28b82">' + escapeHtml(String(err).slice(0, 50)) + '</span>' : '') +
        '</div>';
    }).join('');
    html += '<div style="margin-top:4px;color:#8ab4f8">Prompt：' + escapeHtml(m.prompt || '') + '</div>';
    list.innerHTML = html;
  }

  function panelSetState(m, i, status) {
    if (!m) return;
    m.statuses[i] = status;
    renderList(m);
  }

  function log(msg) {
    const line = '[' + now() + '] ' + msg;
    console.log('[/img]', msg);
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

  /* ============================================================
   * 五、页面 DOM 定位（多层选择器 + 兜底）
   * ============================================================ */
  function getEditor() {
    return document.querySelector('.ql-editor')                       // Quill 编辑器（Gemini 输入框）
      || document.querySelector('rich-textarea [contenteditable="true"]')
      || document.querySelector('main [contenteditable="true"][role="textbox"]')
      || document.querySelector('form [contenteditable="true"]')
      || document.querySelector('#editor [contenteditable="true"]')
      || document.querySelector('div[contenteditable="true"][role="textbox"]')
      || null;
  }

  function composerRoot() {
    const ed = getEditor();
    if (!ed) return null;
    return ed.closest('form')
      || ed.closest('.chat-input-container')
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
    const pats = [/^新聊天/, /^新对话/, /^新建对话/, /^New chat/i, /^Start new chat/i];
    const els = [...document.querySelectorAll('button, a')];
    for (const el of els) {
      const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).trim();
      if (!label || label.length > 40) continue;
      if (pats.some((p) => p.test(label))) {
        if (el.offsetParent !== null || el.getClientRects().length) return el;
      }
    }
    return null;
  }

  async function tryStartNewChat() {
    const b = tryFindNewChatButton();
    if (!b) return false;
    b.click();
    const ok = await waitFor(() => {
      const urlOk = /^\/app\/?$/.test(location.pathname);
      const emptyOk = countResponses() === 0;
      return !!getEditor() && (urlOk || emptyOk);
    }, 12000, 500);
    return !!ok;
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
   * 六、动作：输入、上传、发送、等待
   * ============================================================ */
  async function clearEditor() {
    const ed = getEditor();
    if (!ed) return;
    try {
      ed.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
    } catch (e) { /* 忽略 */ }
    await sleep(200);
  }

  async function setPrompt(text) {
    const ed = getEditor();
    if (!ed) throw new Error('找不到输入框');
    ed.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
    await sleep(400);
    if (!(ed.innerText || '').includes(text.slice(0, 12))) {
      ed.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
      await sleep(400);
      if (!(ed.innerText || '').includes(text.slice(0, 12))) throw new Error('无法输入提示词');
    }
  }

  function uploadViaPaste(file) {
    const ed = getEditor();
    if (!ed) return false;
    try {
      ed.focus();
      const dt = new DataTransfer();
      dt.items.add(file);
      const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
      return ed.dispatchEvent(ev);
    } catch (e) { return false; }
  }

  async function uploadSettle() {
    // 等上传进度指示消失（选择器不匹配时直接放行，不作为失败条件）
    await waitFor(() => {
      const r = composerRoot();
      return !!r && !r.querySelector('mat-progress-spinner, mat-spinner, [role="progressbar"]');
    }, cfg.uploadTimeoutMs, 800);
    await sleep(1000);
  }

  async function uploadFile(file) {
    const nameKey = (file.name.replace(/\.[^.]+$/, '') || file.name).slice(0, 8);
    const beforeImgs = new Set([...(composerRoot() || document).querySelectorAll('img')].map((x) => x.src));
    const attached = () => {
      const r = composerRoot();
      if (!r) return false;
      if ((r.textContent || '').includes(nameKey)) return true;                       // 出现文件名 chip
      return [...r.querySelectorAll('img')].some((x) => !beforeImgs.has(x.src) && x.complete); // 或出现新预览图
    };

    // 途径 1：页面上的 file input（优先 accept 含 image 的）
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

    // 途径 2：向编辑器模拟「粘贴」
    if (uploadViaPaste(file) && await waitFor(attached, 12000, 500)) {
      await uploadSettle();
      log('  ⬆ 已附加（粘贴方式）：' + file.name);
      return;
    }

    throw new Error('无法把图片放入输入框（未找到可用上传入口）');
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
   * 七、下载与命名
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

  async function fetchImageBlob(img) {
    const src = img.currentSrc || img.src || '';
    if (!src) throw new Error('图片地址为空');
    if (src.startsWith('blob:') || src.startsWith('data:')) {
      const r = await fetch(src);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.blob();
    }
    try {
      const r = await fetch(src, { credentials: 'include' });
      if (r.ok) return await r.blob();
    } catch (e) { /* 跨域受限，改走 GM_xmlhttpRequest */ }
    return await new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: src,
        responseType: 'blob',
        onload: (r) => (r.status >= 200 && r.status < 300) ? resolve(r.response) : reject(new Error('HTTP ' + r.status)),
        onerror: () => reject(new Error('下载图片失败（网络或跨域受限）'))
      });
    });
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
      const blob = await fetchImageBlob(imgs[i]);
      if (!blob || blob.size < 1024) throw new Error('下载的图片数据异常');
      const realExt = blobExt(blob);
      let useExt = p.ext;
      if (!cfg.exactName && realExt && realExt !== p.ext) useExt = realExt;
      const filename = p.base + suffix + '.' + useExt;
      if (realExt && realExt !== useExt) {
        log('  ⚠ 生成图实际为 ' + realExt.toUpperCase() + ' 格式，文件名保留 .' + useExt + '（/imgname 可切换）');
      }
      saveBlob(blob, filename);
      log('  💾 已下载：' + filename);
      await sleep(1000); // 避免浏览器下载节流
    }
  }

  /* ============================================================
   * 八、队列调度
   * ============================================================ */
  let localRunning = false;

  async function startRun(files, prompt) {
    const old = metaLoad();
    if (old && !old.done) {
      toast('已有队列在执行中（/imgclear 可停止）');
      return;
    }
    const names = files.map((f) => f.name);
    const meta = {
      prompt: String(prompt).trim(),
      names: names,
      statuses: names.map(() => 'pending'),
      errors: {},
      idx: 0,
      freshChat: false,
      done: false
    };
    metaSave(meta);
    for (let i = 0; i < files.length; i++) await fileSet(i, files[i]);
    log('🚀 新任务：' + names.length + ' 张图片');
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
    if (!m || m.done) return;
    if (!tryAcquireLock()) { log('⏸ 其他标签页正在处理队列'); return; }
    localRunning = true;
    let navigating = false;
    const hb = setInterval(heartbeat, 5000);
    try {
      panelShow(m);
      const ready = await waitFor(() => !!getEditor() && !!composerRoot(), 45000, 600);
      if (!ready) { log('⚠ 页面输入框未就绪；刷新页面后会自动续跑'); return; }

      for (let i = m.idx; i < m.names.length; i++) {
        const cur = metaLoad();
        if (!cur || cur.done) { log('⏹ 队列已被停止'); return; }
        if (m.statuses[i] === 'ok' || m.statuses[i] === 'err') continue;

        if (cfg.newChatPerImage) {
          if (m.freshChat) {
            m.freshChat = false;
            metaSave(m);
          } else {
            log('  ↗ 新开对话…');
            const clicked = await tryStartNewChat();
            if (!clicked) {
              // 找不到「新对话」按钮：跳转到 /app（新对话页），刷新后自动续跑
              m.freshChat = true;
              m.idx = i;
              metaSave(m);
              try { localStorage.setItem('gic-nav', String(Date.now())); } catch (e) {}
              navigating = true;
              log('  ↻ 未找到「新对话」按钮，刷新页面以进入新对话…');
              location.assign('/app');
              return;
            }
          }
        }

        panelSetState(m, i, 'busy');
        log('▶ [' + (i + 1) + '/' + m.names.length + '] ' + m.names[i]);
        try {
          await processOne(i, m.prompt, m.names[i]);
          m.statuses[i] = 'ok';
          panelSetState(m, i, 'ok');
          log('✅ ' + m.names[i]);
        } catch (e) {
          m.statuses[i] = 'err';
          m.errors = m.errors || {};
          m.errors[i] = String((e && e.message) || e);
          panelSetState(m, i, 'err');
          log('❌ ' + m.names[i] + '：' + m.errors[i]);
        }
        m.idx = i + 1;
        metaSave(m);
        await fileDel(i);
        await sleep(1200);
      }

      const okN = m.statuses.filter((s) => s === 'ok').length;
      const errN = m.statuses.filter((s) => s === 'err').length;
      m.done = true;
      metaSave(m);
      log('🎉 队列完成：成功 ' + okN + '，失败 ' + errN);
      toast('处理完成：成功 ' + okN + '，失败 ' + errN, 5000);
    } finally {
      clearInterval(hb);
      localRunning = false;
      if (!navigating) releaseLock();
    }
  }

  /* ============================================================
   * 九、命令入口
   * ============================================================ */
  const CMDS = /^\/(imgf|img|imgset|imgconf|imgname|imgclear|imgdiag|imghelp)\b\s*([\s\S]*)$/i;

  function pickFiles() {
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.multiple = true;
      inp.accept = 'image/*';
      inp.style.cssText = 'position:fixed;left:-9999px;top:0;';
      (document.body || document.documentElement).appendChild(inp);
      const finish = (files) => { try { inp.remove(); } catch (e) {} resolve(files); };
      inp.addEventListener('change', () => finish([...inp.files]), { once: true });
      inp.addEventListener('cancel', () => finish([]), { once: true });
      inp.click();
    });
  }

  /* ---- 文件夹选择（递归抓取所有图片，自动忽略非图片文件） ---- */
  function isImageFile(f) {
    if (!f || !f.name || f.name.startsWith('.')) return false;
    const m = f.name.match(/\.([A-Za-z0-9]+)$/);
    const ext = m ? m[1].toLowerCase() : '';
    if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'].indexOf(ext) >= 0) return true;
    return !!(f.type && f.type.indexOf('image/') === 0);
  }

  function pickFolder() {
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.multiple = true;
      inp.accept = 'image/*';
      try {
        inp.setAttribute('webkitdirectory', '');
        inp.setAttribute('directory', '');
      } catch (e) { /* 忽略 */ }
      inp.style.cssText = 'position:fixed;left:-9999px;top:0;';
      (document.body || document.documentElement).appendChild(inp);
      const finish = (files) => { try { inp.remove(); } catch (e) {} resolve(files); };
      inp.addEventListener('change', () => {
        const imgs = [...inp.files].filter(isImageFile)
          .sort((a, b) => String(a.webkitRelativePath || a.name).localeCompare(String(b.webkitRelativePath || b.name), 'zh-CN'));
        finish(imgs);
      }, { once: true });
      inp.addEventListener('cancel', () => finish([]), { once: true });
      inp.click();
    });
  }

  function handleCommand(text) {
    const m = text.match(CMDS);
    if (!m) return false;
    const cmd = m[1].toLowerCase();
    const arg = m[2].trim();
    (async () => {
      try {
        if (cmd === 'img' || cmd === 'imgf') {
          let prompt = arg || cfg.defaultPrompt;
          if (!prompt || !prompt.trim()) {
            prompt = (window.prompt('请输入提示词（也可先用 /imgset 保存默认提示词）：', '') || '').trim();
            if (!prompt) { toast('已取消'); return; }
          }
          const files = (cmd === 'imgf') ? (await pickFolder()) : (await pickFiles());
          if (!files.length) { toast('未选择图片，已取消'); return; }
          if (cmd === 'imgf') {
            const rel = files[0].webkitRelativePath || '';
            const folder = rel.includes('/') ? rel.split('/')[0] : '';
            log('📂 文件夹：' + (folder || '(未知)') + '，共 ' + files.length + ' 张图片');
            if (files.length > 80) toast('提示：一次排队 ' + files.length + ' 张，如遇浏览器存储不足可分批处理', 6000);
          }
          toast('已加入队列：' + files.length + ' 张图片，开始自动处理…');
          await startRun(files, prompt);
        } else if (cmd === 'imgset') {
          if (arg) {
            cfg.defaultPrompt = arg;
            saveCfg();
            toast('已保存默认提示词');
          } else {
            const p = window.prompt('请输入默认提示词：', cfg.defaultPrompt || '');
            if (p != null && p.trim()) { cfg.defaultPrompt = p.trim(); saveCfg(); toast('已保存默认提示词'); }
          }
        } else if (cmd === 'imgconf') {
          cfg.newChatPerImage = !cfg.newChatPerImage;
          saveCfg();
          toast('每张图新开对话：' + (cfg.newChatPerImage ? '开' : '关'));
        } else if (cmd === 'imgname') {
          cfg.exactName = !cfg.exactName;
          saveCfg();
          toast(cfg.exactName ? '命名：严格使用原文件名' : '命名：原名 + 自动纠正扩展名');
        } else if (cmd === 'imgclear') {
          const q = metaLoad();
          if (q && !q.done) { q.done = true; metaSave(q); releaseLock(); toast('已停止并清除队列'); }
          else toast('当前没有执行中的队列');
        } else if (cmd === 'imgdiag') {
          await sleep(100);
          runDiag();
        } else if (cmd === 'imghelp') {
          showHelp();
        }
      } catch (e) {
        toast('命令出错：' + ((e && e.message) || e));
        log('命令出错：' + ((e && e.message) || e));
      }
    })();
    return true;
  }

  async function quickRun(useFolder) {
    const q = metaLoad();
    if (q && !q.done) { toast('已有队列在执行中（/imgclear 可停止）'); return; }
    let prompt = (cfg.defaultPrompt || '').trim();
    if (!prompt) {
      prompt = (window.prompt('请输入提示词（可用 /imgset 保存默认提示词）：', '') || '').trim();
      if (!prompt) return;
    }
    const files = useFolder ? (await pickFolder()) : (await pickFiles());
    if (!files.length) { toast('未选择图片，已取消'); return; }
    if (useFolder) {
      const rel = files[0].webkitRelativePath || '';
      const folder = rel.includes('/') ? rel.split('/')[0] : '';
      log('📂 文件夹：' + (folder || '(未知)') + '，共 ' + files.length + ' 张图片');
      if (files.length > 80) toast('提示：一次排队 ' + files.length + ' 张，如遇浏览器存储不足可分批处理', 6000);
    }
    toast('已加入队列：' + files.length + ' 张图片，开始自动处理…');
    await startRun(files, prompt);
  }

  function showHelp() {
    alert([
      'Gemini /img 命令 — 使用帮助',
      '',
      '/img <提示词>     选图并执行（提示词可省略，用默认）',
      '/imgf <提示词>    选择整个文件夹批量处理',
      '/imgset <提示词>  设置默认提示词',
      '/imgconf          切换「每张图新开对话」',
      '/imgname          切换「严格原名 / 纠正扩展名」',
      '/imgclear         停止并清除当前队列',
      '/imgdiag          诊断页面元素（失效排查）',
      '/imghelp          显示本帮助',
      '',
      '快捷键：Alt+G = 选图执行 / Alt+F = 选文件夹（用默认提示词）',
      '流程：自动上传图片 → 发送提示词 → 等待生成 → 按原文件名下载',
      '下载位置：浏览器「下载」文件夹'
    ].join('\n'));
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
    const ed = getEditor();
    lines.push('输入框：' + (ed ? '✅ ' + describeEl(ed) : '❌ 未找到'));
    const cr = composerRoot();
    lines.push('输入区容器：' + (cr ? '✅ ' + describeEl(cr) : '❌ 未找到'));
    const sb = findSendButton();
    lines.push('发送按钮：' + (sb ? '✅ ' + (sb.getAttribute('aria-label') || describeEl(sb)) : '❌ 未找到'));
    const ncb = tryFindNewChatButton();
    lines.push('新对话按钮：' + (ncb ? '✅ ' + (ncb.getAttribute('aria-label') || (ncb.textContent || '').trim().slice(0, 20)) : '❌ 未找到'));
    const inputs = [...document.querySelectorAll('input[type="file"]')];
    lines.push('文件输入框：' + inputs.length + ' 个');
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
   * 十、事件拦截（命令识别）
   * ============================================================ */
  // 输入框内「命令 + 回车」：document-start 注册，抢在页面脚本之前
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
    const t = e.target;
    if (!t || typeof t.closest !== 'function') return;
    const editable = t.isContentEditable || t.tagName === 'TEXTAREA' ||
      (t.tagName === 'INPUT' && (t.type === 'text' || t.type === 'search'));
    if (!editable) return;
    let text = '';
    try { text = (t.isContentEditable ? t.innerText : t.value) || ''; } catch (err) { return; }
    text = text.trim();
    if (!CMDS.test(text)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    clearEditor();
    handleCommand(text);
  }, true);

  // 输入命令后点击「发送」按钮同样触发命令
  document.addEventListener('click', (e) => {
    const btn = (e.target && typeof e.target.closest === 'function') ? e.target.closest('button') : null;
    if (!btn) return;
    const ed = getEditor();
    if (!ed) return;
    const text = (ed.innerText || '').trim();
    if (!CMDS.test(text)) return;
    const sb = findSendButton();
    const label = btn.getAttribute('aria-label') || '';
    if (btn === sb || /发送|Send/i.test(label)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      clearEditor();
      handleCommand(text);
    }
  }, true);

  // Alt+G（选图）/ Alt+F（选文件夹）快捷键
  document.addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      const k = e.key.toLowerCase();
      if (k === 'g') { e.preventDefault(); quickRun(false); }
      else if (k === 'f') { e.preventDefault(); quickRun(true); }
    }
  });

  /* ============================================================
   * 十一、Tampermonkey 菜单命令
   * ============================================================ */
  try {
    GM_registerMenuCommand('🖼 选图并执行（默认提示词）', () => quickRun(false));
    GM_registerMenuCommand('📁 选整个文件夹批量处理（默认提示词）', () => quickRun(true));
    GM_registerMenuCommand('✏️ 设置默认提示词', () => {
      const p = window.prompt('默认提示词（/img 不带参数时使用）：', cfg.defaultPrompt || '');
      if (p != null && p.trim()) { cfg.defaultPrompt = p.trim(); saveCfg(); toast('已保存默认提示词'); }
    });
    GM_registerMenuCommand('🔄 切换：每张图新开对话（当前 ' + (cfg.newChatPerImage ? '开' : '关') + '）', () => {
      cfg.newChatPerImage = !cfg.newChatPerImage;
      saveCfg();
      toast('每张图新开对话：' + (cfg.newChatPerImage ? '开' : '关'));
    });
    GM_registerMenuCommand('🔤 切换：严格原文件名（当前 ' + (cfg.exactName ? '开' : '关') + '）', () => {
      cfg.exactName = !cfg.exactName;
      saveCfg();
      toast(cfg.exactName ? '命名：严格使用原文件名' : '命名：原名 + 自动纠正扩展名');
    });
    GM_registerMenuCommand('📋 显示/隐藏状态面板', () => {
      const p = ensurePanel();
      p.style.display = (p.style.display === 'none' || !p.style.display) ? 'flex' : 'none';
      const m = metaLoad();
      if (m) renderList(m);
    });
    GM_registerMenuCommand('🗑 停止并清除队列', () => {
      const q = metaLoad();
      if (q && !q.done) { q.done = true; metaSave(q); releaseLock(); toast('已停止并清除队列'); }
      else toast('当前没有执行中的队列');
    });
    GM_registerMenuCommand('🔍 诊断页面元素', () => runDiag());
  } catch (e) { /* 菜单注册失败不影响主功能 */ }

  /* ============================================================
   * 十二、启动：断点续跑 + 首次提示
   * ============================================================ */
  async function boot() {
    if (document.readyState === 'loading') {
      await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
    }
    await sleep(1500);
    try {
      const m = metaLoad();
      if (m && !m.done) {
        log('↻ 检测到未完成的队列，自动续跑…');
        processQueue();
      } else if (!sessionStorage.getItem('gic-hint')) {
        sessionStorage.setItem('gic-hint', '1');
        toast('已启用 /img 命令：/img 提示词 选图，/imgf 提示词 选文件夹（Alt+G / Alt+F）', 6000);
      }
    } catch (e) {
      console.error('[/img] boot:', e);
    }
  }

  boot();
})();
