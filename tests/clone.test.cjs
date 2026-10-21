const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const C = require('../clone-core.js');
const root = path.join(__dirname, '..');
const url = 'https://www.autodl.com/cloneInstance?region=cq-A1&id=source-abc&copy_data_disk=1&expand_size=0';
const config = C.options({ models: ['RTX 4090'], count: 2, maxPrice: 4, interval: 15, preview: false });
const machine = { id: 'host123', model: 'RTX 4090', available: 2, price: 1.98, enabled: true };

test('clone identity requires data disk, exact source/region and official origin', () => {
  assert.equal(C.context(url).sourceId, 'source-abc');
  for (const bad of [url.replace('copy_data_disk=1', 'copy_data_disk=0'), url.replace('www.autodl.com', 'other.test'),
    url.replace('/cloneInstance', '/createInstance'), url.replace('id=source-abc', 'id=')]) {
    assert.throws(() => C.context(bad));
  }
  assert.throws(() => C.assertContext(C.context(url.replace('cq-A1', 'bj-B1')), C.context(url)));
  assert.throws(() => C.assertContext(C.context(url.replace('source-abc', 'other-def')), C.context(url)));
});

test('full-instance budget, exact GPU model, stock and disabled host filtering', () => {
  assert.equal(C.eligible(machine, config), true);
  for (const changed of [{ price: 2.01 }, { model: 'RTX 4090D' }, { available: 1 }, { enabled: false },
    { price: NaN }, { price: 0 }, { id: '' }]) {
    assert.equal(C.eligible({ ...machine, ...changed }, config), false);
  }
  assert.equal(C.eligible({ ...machine, price: 2 }, config), true);
  assert.equal(C.money('￥1,234.56/时 ￥1999/时'), 1234.56);
});

test('config rejects missing GPU, CPU, invalid quantity, unbounded budget or rapid refresh', () => {
  for (const changed of [{ models: [] }, { models: ['CPU'] }, { count: 9 }, { count: 1.5 }, { maxPrice: '' },
    { maxPrice: Infinity }, { interval: 5 }, { interval: NaN }]) {
    assert.throws(() => C.options({ ...config, ...changed }));
  }
  assert.equal(C.options({ ...config, preview: undefined }).preview, true);
});

function worker(store, snapshots = []) {
  let onMessage, alarm;
  const notices = [];
  const sandbox = { console, URL, crypto: require('node:crypto').webcrypto, CloneCore: C,
    monitoringEnabled: false, intervalId: null, checkInProgress: false, clearInterval() {},
    setTimeout: fn => { queueMicrotask(fn); return 1; }, importScripts() {},
    sendEmailNotification: async data => notices.push({ email: data }),
    chrome: {
      storage: { local: { get: async key => ({ [key]: store[key] }), set: async values => Object.assign(store, structuredClone(values)) } },
      runtime: { onMessage: { addListener: fn => { onMessage = fn; } } },
      notifications: { create: async data => notices.push(data) },
      alarms: { create: async () => {}, clear: async () => {}, onAlarm: { addListener: fn => { alarm = fn; } } },
      tabs: { create: async () => ({ id: 99 }), remove: async () => {},
        get: async id => ({ id, status: 'complete', url: 'https://www.autodl.com/console/instance/list' }),
        sendMessage: async (id, request) => {
          assert.equal(request.action, 'cloneListSnapshot', 'tracking may only read instance lists');
          return { success: true, instances: snapshots };
        } }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'clone-background.js'), 'utf8'), sandbox);
  return { notices, tick: () => alarm({ name: 'clone-watchdog' }), send: (action, data = {}, tabId = 7) =>
    new Promise(resolve => onMessage({ action, ...data }, { tab: { id: tabId } }, resolve)) };
}
function watching(preview = false) {
  return { id: 'job-1', tabId: 7, phase: 'watching', config: { ...config, preview },
    context: { ...C.context(url), regionName: '重庆A区', dataCenter: 'chongqingDC1' }, baseline: ['source-abc', 'busy-710'] };
}
const selected = { id: 'host123', model: 'RTX 4090', name: '123机', price: 1.98, total: 3.96 };
test('only one reservation survives concurrent requests and worker restart', async () => {
  const store = { cloneMonitorJob: watching() };
  const w = worker(store);
  const results = await Promise.all([w.send('cloneReserve', { id: 'job-1', selected }), w.send('cloneReserve', { id: 'job-1', selected })]);
  assert.equal(results.filter(r => r.success).length, 1);
  assert.equal(store.cloneMonitorJob.phase, 'submitting');
  const restarted = worker(store);
  assert.equal((await restarted.send('cloneReserve', { id: 'job-1', selected })).success, false);
});
test('other tabs, preview jobs and changed IDs cannot reserve', async () => {
  for (const [preview, jobId, tabId] of [[true, 'job-1', 7], [false, 'wrong', 7], [false, 'job-1', 8]]) {
    const store = { cloneMonitorJob: watching(preview) };
    assert.equal((await worker(store).send('cloneReserve', { id: jobId, selected }, tabId)).success, false);
    assert.equal(store.cloneMonitorJob.phase, 'watching');
  }
});
test('malformed or over-budget reservation cannot take the submission lock', async () => {
  for (const changed of [{ total: NaN }, { total: 0 }, { price: NaN }, { total: 5 }, { total: 3, price: 1.98 }, { id: '' }]) {
    const store = { cloneMonitorJob: watching() };
    const result = await worker(store).send('cloneReserve', { id: 'job-1', selected: { ...selected, ...changed } });
    assert.equal(result.success, false);
    assert.equal(store.cloneMonitorJob.phase, 'watching');
  }
});
test('stop before reservation cancels; stop after reservation retains uncertainty lock', async () => {
  const store = { cloneMonitorJob: watching() };
  const w = worker(store);
  await w.send('cloneStop');
  assert.equal((await w.send('cloneReserve', { id: 'job-1', selected })).success, false);
  store.cloneMonitorJob = watching();
  await w.send('cloneReserve', { id: 'job-1', selected });
  await w.send('cloneStop');
  assert.equal(store.cloneMonitorJob.phase, 'uncertain');
  assert.equal((await w.send('clonePermit', { id: 'job-1' })).success, false);
});
test('tracking does not call success for creating, failed or no-card instances', async () => {
  for (const status of ['创建中', '克隆中', '运行中 无卡模式', '创建失败']) {
    const job = { ...watching(), selected, phase: 'submitted', submittedAt: Date.now() };
    const store = { cloneMonitorJob: job };
    const w = worker(store, [{ id: 'new-123', region: '重庆A区', host: '123机', spec: 'RTX 4090 * 2卡', status }]);
    await w.tick();
    assert.notEqual(store.cloneMonitorJob.phase, 'success');
    assert.equal(w.notices.some(n => n.email), false);
  }
});
test('unique new GPU-running instance ends job; existing busy 710 instance is ignored', async () => {
  const store = { cloneMonitorJob: { ...watching(), selected, phase: 'submitted', submittedAt: Date.now() } };
  const w = worker(store, [
    { id: 'busy-710', host: '710机', region: '重庆A区', status: '运行中', spec: 'vGPU-32GB * 1卡' },
    { id: 'new-123', host: '123机', region: '重庆A区', status: '运行中', spec: 'RTX 4090 * 2卡' }
  ]);
  await w.tick();
  assert.equal(store.cloneMonitorJob.phase, 'success');
  assert.equal(store.cloneMonitorJob.newInstanceId, 'new-123');
  assert.equal(w.notices.filter(n => n.email).length, 1);
});

test('DOM adapter reads live-style clone controls, ignores old price and fails on unlocked region', async () => {
  const { parseHTML } = require('linkedom');
  const { document, window } = parseHTML(`<html><body>
    克隆实例仅能在同一地区内进行，以实例：source-abc的系统创建新实例
    <div class="filter-item"><span class="filter-label">选择地区:</span>
      <label>重庆A区<input type="radio" value="chongqingDC1" checked></label>
      <label>北京B区<input type="radio" value="beijingDC2" disabled></label></div>
    <div class="filter-item"><span class="filter-label">GPU型号:</span>
      <label><input type="checkbox" value="false">全部</label>
      <label><input type="checkbox" value="RTX 4090">RTX 4090</label></div>
    <table class="el-table__body"><tbody><tr>
      <td><input type="radio" value="host123"></td><td>123机</td>
      <td><div class="cell"><div>RTX 4090<br>24GB</div></div></td><td>2 / 8</td>
      <td>CPU</td><td>Xeon</td><td>50GB</td><td>13.0</td>
      <td><div class="price"><span>￥1.98</span>/时<span style="text-decoration:line-through">￥9.99/时</span></div></td>
    </tr></tbody></table></body></html>`);
  for (const input of document.querySelectorAll('input')) {
    Object.defineProperty(input, 'checked', { get: () => input.hasAttribute('checked') });
    Object.defineProperty(input, 'disabled', { get: () => input.hasAttribute('disabled') });
  }
  const sandbox = { CloneCore: C, window, document, location: { href: url }, console, setInterval: () => 1,
    chrome: { runtime: { onMessage: { addListener() {} } } } };
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(root, 'clone-page.js'), 'utf8')
    .replace('  chrome.runtime.onMessage.addListener', '  globalThis.adapter = { pageContext, machines };\n  chrome.runtime.onMessage.addListener');
  vm.runInContext(source, sandbox);
  assert.equal(sandbox.adapter.pageContext().dataCenter, 'chongqingDC1');
  const row = sandbox.adapter.machines()[0];
  assert.equal(row.model, 'RTX 4090');
  assert.equal(row.price, 1.98);
  assert.equal(row.available, 2);
  assert.equal(C.eligible(row, config), true);
  document.querySelector('input[value="beijingDC2"]').removeAttribute('disabled');
  assert.throws(() => sandbox.adapter.pageContext(), /地区未锁定/);
});

async function pageWorkflow({ preview = false, available = 2, quoted = 3.96, cancelOnReserve = false } = {}) {
  const { parseHTML } = require('linkedom');
  const { document, window } = parseHTML(`<html><body>
    克隆实例仅能在同一地区内进行，以实例：source-abc的系统创建新实例
    <div class="filter-item"><span class="filter-label">选择地区:</span>
      <label>重庆A区<input type="radio" value="chongqingDC1" checked></label></div>
    <div class="filter-item"><span class="filter-label">GPU型号:</span>
      <label><input type="checkbox" value="RTX 4090" checked>RTX 4090</label></div>
    <div class="filter-item"><span class="filter-label">GPU数量:</span>
      <label><input type="radio" value="2" checked>2</label></div>
    <label><input type="radio" value="payg" checked>按量计费</label>
    <div class="el-table"><table><thead><tr><th class="descending">空闲GPU<i class="sort-caret descending"></i></th></tr></thead></table>
      <div class="el-table__body-wrapper"><table class="el-table__body"><tbody><tr>
        <td><input type="radio" value="host123"></td><td>123机</td>
        <td><div class="cell"><div>RTX 4090<br>24GB</div></div></td><td>${available} / 8</td>
        <td>CPU</td><td>Xeon</td><td>50GB</td><td>13.0</td>
        <td><div class="price"><span>￥1.98</span>/时</div></td>
      </tr></tbody></table></div></div><div class="sum">配置费用：￥${quoted}/时</div>
      <button>创建并开机</button></body></html>`);
  window.__autodlCloneAdapter = false;
  for (const input of document.querySelectorAll('input')) {
    Object.defineProperty(input, 'checked', { get: () => input.hasAttribute('checked') });
    Object.defineProperty(input, 'disabled', { get: () => input.hasAttribute('disabled') });
  }
  document.querySelector('.el-table__body tr').addEventListener('click', () =>
    document.querySelector('input[value="host123"]').setAttribute('checked', ''));
  const create = document.querySelector('button');
  create.getClientRects = () => [1];
  let clicks = 0;
  create.addEventListener('click', () => clicks++);
  const actions = [];
  let reloadScheduled = false;
  const job = watching(preview);
  const sandbox = { CloneCore: C, window, document, location: { href: url, pathname: '/cloneInstance', reload() {} },
    console, URL, Event: window.Event, clearTimeout() {}, setInterval: () => 1,
    setTimeout: (fn, ms) => { if (ms >= 10000) reloadScheduled = true; else queueMicrotask(fn); return 1; },
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async request => {
      actions.push(request.action);
      if (request.action === 'cloneError') actions.push(request.message);
      if (request.action === 'cloneJob') return { job };
      if (request.action === 'cloneReserve') { job.phase = cancelOnReserve ? 'stopped' : 'submitting'; return { success: true }; }
      if (request.action === 'clonePermit') return { success: job.phase === 'submitting' };
      return { success: true };
    } } } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'clone-page.js'), 'utf8')
    .replace('  chrome.runtime.onMessage.addListener', '  globalThis.runAdapter = run;\n  chrome.runtime.onMessage.addListener'), sandbox);
  await sandbox.runAdapter();
  return { clicks, actions, reloadScheduled };
}
test('page preview selects a candidate without calling reserve or clicking create', async () => {
  const result = await pageWorkflow({ preview: true });
  assert.ok(result.actions.includes('clonePreview'), JSON.stringify(result.actions));
  assert.equal(result.actions.includes('cloneReserve'), false);
  assert.equal(result.clicks, 0);
});
test('page workflow reserves then clicks once, and cancels before click if stopped', async () => {
  const submitted = await pageWorkflow();
  assert.equal(submitted.clicks, 1, JSON.stringify(submitted.actions));
  assert.ok(submitted.actions.includes('cloneClicked'));
  const cancelled = await pageWorkflow({ cancelOnReserve: true });
  assert.equal(cancelled.clicks, 0);
});
test('no stock schedules refresh; changed checkout total fails closed', async () => {
  const empty = await pageWorkflow({ available: 0 });
  assert.equal(empty.reloadScheduled, true);
  assert.equal(empty.clicks, 0);
  const changed = await pageWorkflow({ quoted: 4.5 });
  assert.ok(changed.actions.includes('cloneError'));
  assert.equal(changed.actions.includes('cloneReserve'), false);
  assert.equal(changed.clicks, 0);
});
