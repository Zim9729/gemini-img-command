'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'gemini-img-command.user.js'), 'utf8');

function loadFunction(name, globals = {}) {
  const signature = new RegExp('  (?:async )?function ' + name + '\\(');
  const start = source.search(signature);
  assert.notEqual(start, -1, name + ' must exist in the userscript');

  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  assert.notEqual(end, -1, name + ' must have a complete body');
  return vm.runInNewContext('(' + source.slice(start, end) + ')', { Date, ...globals });
}

const parseUsageResetAt = loadFunction('parseUsageResetAt');

test('uses the current-usage reset time instead of the weekly limit', () => {
  const now = new Date(2026, 8, 4, 19, 0, 0).getTime();
  const usagePage = [
    '用量限额',
    '当前用量 已使用 100%',
    '重置时间：20:17',
    '每周限额 已使用 18%',
    '重置时间：9月5日12:17'
  ].join('\n');

  assert.equal(
    parseUsageResetAt(usagePage, now),
    new Date(2026, 8, 4, 20, 17, 0, 0).getTime()
  );
});

test('rolls a time-only current-usage reset forward to tomorrow when needed', () => {
  const now = new Date(2026, 8, 4, 20, 18, 0).getTime();
  const usagePage = '当前用量\n已使用 100%\n重置时间：20:17\n每周限额\n重置时间：9月5日12:17';

  assert.equal(
    parseUsageResetAt(usagePage, now),
    new Date(2026, 8, 5, 20, 17, 0, 0).getTime()
  );
});

test('accepts an explicit date and an English PM marker from the current-usage card', () => {
  const now = new Date(2026, 8, 4, 12, 0, 0).getTime();
  const usagePage = 'Current usage\n100% used\nReset time: 9/5 8:17 PM\nWeekly limit\nReset time: 9/5 12:17 PM';

  assert.equal(
    parseUsageResetAt(usagePage, now),
    new Date(2026, 8, 5, 20, 17, 0, 0).getTime()
  );
});

function clockHarness() {
  let now = new Date(2026, 8, 5, 16, 15).getTime();
  let polls = 0;
  const globals = {
    Date: class extends Date { static now() { return now; } },
    cfg: { quotaResetAt: 0 },
    cancelRequested: false,
    quotaRetryAt: 0,
    metaLoad: () => ({ id: 'queue', stopped: false }),
    log: () => {},
    saveCfg: () => {},
    document: { body: { innerText: '' } },
    waitFor: async (fn, duration) => {
      assert.ok(++polls <= 400, 'quota wait must terminate');
      if (!fn()) now += duration;
    }
  };
  globals.parseUsageResetAt = loadFunction('parseUsageResetAt');
  globals.usageResetWaitMs = loadFunction('usageResetWaitMs', globals);
  return {
    globals,
    now: () => now,
    setNow: (value) => { now = value; },
    wait: loadFunction('waitForQuotaRetry', globals),
    sync: loadFunction('syncUsageResetTime', globals)
  };
}

test('a reset learned during fallback waiting resumes at 16:17:15, not 16:45', async () => {
  const h = clockHarness();
  const resetAt = new Date(2026, 8, 5, 16, 17).getTime();
  // The page is opened after waiting has already started.
  const originalWait = h.globals.waitFor;
  h.globals.waitFor = async (fn, duration) => {
    await originalWait(fn, duration);
    h.globals.cfg.quotaResetAt = resetAt;
  };
  await loadFunction('waitForQuotaRetry', h.globals)('queue', 30 * 60000);
  assert.equal(h.now(), resetAt + 15000);
});

test('unchanged usage text does not promote an expired reset to tomorrow', () => {
  const h = clockHarness();
  const resetAt = new Date(2026, 8, 5, 16, 17).getTime();
  h.globals.document.body.innerText = '当前用量\n重置时间：16:17\n每周限额';
  h.sync();
  assert.equal(h.globals.cfg.quotaResetAt, resetAt);
  h.setNow(resetAt);
  h.sync();
  assert.equal(h.globals.cfg.quotaResetAt, resetAt);
});

test('wait keeps its deadline when the usage page stays open across reset', async () => {
  const h = clockHarness();
  const resetAt = new Date(2026, 8, 5, 16, 17).getTime();
  h.globals.document.body.innerText = '当前用量\n重置时间：16:17';
  h.sync();
  const originalWait = h.globals.waitFor;
  h.globals.waitFor = async (fn, duration) => {
    await originalWait(fn, duration);
    h.sync();
  };
  await loadFunction('waitForQuotaRetry', h.globals)('queue', 30 * 60000);
  assert.equal(h.now(), resetAt + 15000);
});

test('a near reset keeps only the fixed 15-second grace period', () => {
  const h = clockHarness();
  h.globals.cfg.quotaResetAt = h.now() + 10000;
  assert.equal(h.globals.usageResetWaitMs(), 25000);
});

test('fallback waiting still ends when no usage time is available', async () => {
  const h = clockHarness();
  const start = h.now();
  await h.wait('queue', 30 * 60000);
  assert.equal(h.now(), start + 30 * 60000);
});

test('a new explicit usage deadline can extend an active wait', async () => {
  const h = clockHarness();
  const resetAt = h.now() + 2 * 60000;
  h.globals.cfg.quotaResetAt = resetAt;
  const originalWait = h.globals.waitFor;
  h.globals.waitFor = async (fn, duration) => {
    await originalWait(fn, duration);
    h.globals.cfg.quotaResetAt = resetAt + 60000;
  };
  await loadFunction('waitForQuotaRetry', h.globals)('queue', 2 * 60000 + 15000);
  assert.equal(h.now(), resetAt + 60000 + 15000);
});

for (const state of [null, { id: 'other' }, { id: 'queue', stopped: true }, { id: 'queue', done: true }]) {
  test('quota wait exits without retry for inactive queue ' + JSON.stringify(state), async () => {
    const h = clockHarness();
    h.globals.metaLoad = () => state;
    const start = h.now();
    assert.equal(await loadFunction('waitForQuotaRetry', h.globals)('queue', 60000), false);
    assert.equal(h.now(), start);
  });
}

test('a changed usage time is still accepted after the previous reset', () => {
  const h = clockHarness();
  h.globals.cfg.quotaResetAt = h.now() - 60000;
  h.globals.document.body.innerText = '当前用量\n重置时间：17:17';
  h.sync();
  assert.equal(h.globals.cfg.quotaResetAt, new Date(2026, 8, 5, 17, 17).getTime());
});

test('local cancellation exits without waiting or retrying', async () => {
  const h = clockHarness();
  h.globals.cancelRequested = true;
  const start = h.now();
  assert.equal(await loadFunction('waitForQuotaRetry', h.globals)('queue', 60000), false);
  assert.equal(h.now(), start);
});

test('a suspended tab resumes immediately after waking past its deadline', async () => {
  const h = clockHarness();
  const resetAt = h.now() + 60000;
  h.globals.cfg.quotaResetAt = resetAt;
  h.globals.waitFor = async () => { h.setNow(resetAt + 5 * 60000); };
  assert.equal(await loadFunction('waitForQuotaRetry', h.globals)('queue', 30 * 60000), true);
  assert.equal(h.now(), resetAt + 5 * 60000);
});

test('queue retries the limited image and processes remaining images after reset', async () => {
  const h = clockHarness();
  const resetAt = new Date(2026, 8, 5, 16, 17).getTime();
  let stored = {
    id: 'queue', names: ['first.png', 'second.png'], prompt: 'edit',
    statuses: ['pending', 'pending'], idx: 0, done: false, stopped: false
  };
  const attempts = [];
  const logs = [];
  const noop = () => {};
  Object.assign(h.globals, {
    localRunning: false,
    metaLoad: () => structuredClone(stored),
    metaSave: (value) => { stored = structuredClone(value); },
    tryAcquireLock: () => true,
    lockHeldByMe: () => true,
    sleep: async () => {},
    heartbeat: noop, setInterval: () => 1, clearInterval: noop,
    panelShow: noop, renderList: noop, toast: noop,
    releaseLock: noop, updatePanelState: noop, fileDel: async () => {},
    panelSetState: (m, index, status) => { m.statuses[index] = status; },
    getEditor: () => ({}), composerRoot: () => ({}),
    parseQuotaWaitMs: () => null, fmtDur: String,
    log: (message) => logs.push(message),
    processOne: async (index) => {
      attempts.push({ index, at: h.now() });
      if (attempts.length === 1) throw Object.assign(new Error('quota'), { quota: true });
    }
  });
  const originalWait = h.globals.waitFor;
  h.globals.waitFor = async (fn, duration) => {
    if (fn()) return true;
    await originalWait(fn, duration);
    h.globals.cfg.quotaResetAt = resetAt;
  };
  h.globals.waitForQuotaRetry = loadFunction('waitForQuotaRetry', h.globals);
  await loadFunction('processQueue', h.globals)();
  assert.deepEqual(attempts.map((item) => item.index), [0, 0, 1]);
  assert.equal(attempts[1].at, resetAt + 15000);
  assert.deepEqual(stored.statuses, ['ok', 'ok']);
  assert.equal(stored.done, true);
  assert.equal(logs.some((line) => line.includes('队列异常终止')), false);
});
