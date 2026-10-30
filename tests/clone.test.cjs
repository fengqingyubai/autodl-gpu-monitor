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

test('rental URLs accept ordinary creation routes and reject Pro, foreign and clone routes', () => {
  for (const path of ['/create', '/create/', '/create/cq-A1/host123/2/payg']) {
    assert.equal(C.rentalContext(`https://www.autodl.com${path}`).mode, 'rent');
  }
  for (const path of ['/create/pro', '/createInstance', '/cloneInstance', '/create?id=source-abc', '/create?copy_data_disk=1']) {
    assert.throws(() => C.rentalContext(`https://www.autodl.com${path}`));
  }
  assert.throws(() => C.rentalContext('https://other.test/create'));
  const ctx = { ...C.rentalContext('https://www.autodl.com/create'), region: 'cq-A1', imageSelection: 'PyTorch / 2.5 / 3.12 / CUDA 12.4' };
  assert.throws(() => C.assertContext({ ...ctx, imageSelection: 'other' }, ctx), /镜像/);
  assert.throws(() => C.assertContext({ ...ctx, region: 'bj-A1' }, ctx), /地区/);
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
    { maxPrice: Infinity }, { maxPrice: 1.001 }, { interval: 2 }, { interval: 3.5 }, { interval: '' }, { interval: NaN }]) {
    assert.throws(() => C.options({ ...config, ...changed }));
  }
  assert.equal('preview' in C.options({ ...config, preview: true }), false);
});

function worker(store, snapshots = [], pageContext) {
  let onMessage, alarm;
  const notices = [];
  const sandbox = { console, URL, crypto: require('node:crypto').webcrypto, CloneCore: C,
    createDiagnosticLogger: require('../diagnostics.js').createDiagnosticLogger,
    cleanDiagnosticDetails: require('../diagnostics.js').clean,
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
          if (pageContext && request.action === 'cloneContext') return { success: true, context: pageContext };
          if (pageContext && request.action === 'cloneRun') return { success: true };
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

function rentContext() {
  return { ...C.rentalContext('https://www.autodl.com/create'), region: 'cq-A1', dataCenter: 'chongqingDC1',
    regionName: '重庆A区', imageSelection: 'PyTorch / 2.5 / 3.12 / CUDA 12.4', imageCuda: '12.4',
    adapterVersion: C.VERSION, models: ['RTX 4090'] };
}
test('rental starts with no source or existing instances and shares the one-shot barrier', async () => {
  const store = {};
  const w = worker(store, [], rentContext());
  const started = await w.send('cloneStart', { tabId: 7, mode: 'rent', config });
  assert.equal(started.success, true, started.error);
  const job = store.cloneMonitorJob;
  assert.equal(job.context.mode, 'rent');
  assert.deepEqual(Array.from(job.baseline), []);
  const reserved = await w.send('cloneReserve', { id: job.id, selected });
  assert.equal(reserved.success, true);
  const duplicate = await w.send('cloneReserve', { id: job.id, selected });
  assert.equal(duplicate.success, false);
  const restarted = await w.send('cloneStart', { tabId: 7, mode: 'rent', config });
  assert.equal(restarted.success, false);
  await w.send('cloneStop');
  assert.equal(store.cloneMonitorJob.phase, 'uncertain');
});
test('rental cannot bypass clone mode or start without image configuration', async () => {
  const ctx = rentContext();
  const mismatched = await worker({}, [], ctx).send('cloneStart', { tabId: 7, config });
  assert.equal(mismatched.success, false);
  const incomplete = await worker({}, [], { ...ctx, imageSelection: '' }).send('cloneStart', { tabId: 7, mode: 'rent', config });
  assert.equal(incomplete.success, false);
  const cloneCtx = { ...watching().context, adapterVersion: C.VERSION, models: ['RTX 4090'] };
  const clone = await worker({}, [], cloneCtx).send('cloneStart', { tabId: 7, config });
  assert.equal(clone.success, false);
  assert.match(clone.error, /未找到源实例/);
});
test('rental tracking confirms a unique GPU-running instance and sends notifications once', async () => {
  const job = { ...watching(), phase: 'submitted', context: rentContext(), selected, submittedAt: Date.now() };
  const store = { cloneMonitorJob: job };
  const w = worker(store, [{ id: 'new-rental', region: '重庆A区', host: '123机', spec: 'RTX 4090 * 2卡', status: '运行中' }]);
  await w.tick();
  await w.tick();
  assert.equal(store.cloneMonitorJob.phase, 'success');
  assert.match(store.cloneMonitorJob.message, /新租实例/);
  assert.equal(w.notices.filter(n => n.email).length, 1);
});
test('worker diagnostics export captures page version, price comparison and prior job context', async () => {
  const store = { cloneMonitorJob: watching() };
  const w = worker(store);
  await w.send('cloneDiagnostic', { id: 'job-1', adapterVersion: C.VERSION, event: 'price.check',
    details: { hourlyQuote: 2.19, dailyQuote: 0, count: 1, expectedTotal: 2.19, maxPrice: 3, token: 'do-not-log' } });
  const exported = await w.send('diagnosticRead');
  assert.equal(exported.currentJob.jobId, 'job-1');
  assert.equal(exported.extensionVersion, C.VERSION);
  const price = exported.log.entries.find(entry => entry.event === 'price.check');
  assert.equal(price.details.pageVersion, C.VERSION);
  assert.equal(price.details.hourlyQuote, 2.19);
  assert.equal(price.details.dailyQuote, 0);
  assert.equal(JSON.stringify(exported).includes('do-not-log'), false);
});
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

test('instance list reads numeric and letter-prefixed hosts with their regions', async () => {
  const { parseHTML } = require('linkedom');
  for (const host of ['007机', 'E49机']) {
    const { document, window } = parseHTML(`<html><body>
      <table class="el-table__body"><tbody><tr>
        <td>西北B区 / ${host}<br>g2rmhqwyut-f1c5cd0f<br>用户创建</td>
        <td>已关机</td><td>vGPU-32GB * 1卡</td>
      </tr></tbody></table>
    </body></html>`);
    let listener;
    const sandbox = { CloneCore: C, window: {}, document, location: { pathname: '/console/instance/list' },
      URL, console, setInterval: () => 1,
      chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } } };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(root, 'clone-page.js'), 'utf8'), sandbox);
    const response = await new Promise(resolve => listener({ action: 'cloneListSnapshot' }, {}, resolve));
    assert.equal(response.success, true);
    assert.equal(response.instances.length, 1);
    assert.equal(response.instances[0].id, 'g2rmhqwyut-f1c5cd0f');
    assert.equal(response.instances[0].region, '西北B区');
    assert.equal(response.instances[0].host, host);
    assert.equal(response.instances[0].status, '已关机');
  }
});

test('instance list accepts an explicit empty account but rejects a page without loaded results', async () => {
  const { parseHTML } = require('linkedom');
  for (const empty of [true, false]) {
    const { document } = parseHTML(`<html><body>${empty ? '<span class="el-table__empty-text">暂无数据</span>' : ''}</body></html>`);
    let listener;
    const sandbox = { CloneCore: C, window: {}, document, location: { pathname: '/console/instance/list' },
      URL, console, setInterval: () => 1, setTimeout: fn => { queueMicrotask(fn); return 1; },
      chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } } };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(root, 'clone-page.js'), 'utf8'), sandbox);
    const response = await new Promise(resolve => listener({ action: 'cloneListSnapshot' }, {}, resolve));
    assert.equal(response.success, empty);
    if (empty) assert.equal(response.instances.length, 0);
    else assert.match(response.error, /未加载/);
  }
});

test('rental context requires exactly one region and a complete basic image', () => {
  const { parseHTML } = require('linkedom');
  const { document } = parseHTML(`<html><body>
    <div class="filter-item"><span class="filter-label">选择地区:</span>
      <label>重庆A区<input type="checkbox" value="cq-A1" checked></label>
      <label>北京A区<input type="checkbox" value="bj-A1"></label></div>
    <div class="filter-item"><span class="filter-label">GPU型号:</span>
      <label><input type="checkbox" value="RTX 4090">RTX 4090</label></div>
    <div class="card image"><label><input type="radio" value="basicImage" checked>基础镜像</label>
      <div class="el-cascader"><input value="PyTorch / 2.5 / 3.12 / CUDA 12.4"></div></div>
  </body></html>`);
  for (const input of document.querySelectorAll('input')) {
    Object.defineProperty(input, 'checked', { get: () => input.hasAttribute('checked') });
    Object.defineProperty(input, 'disabled', { get: () => input.hasAttribute('disabled') });
  }
  let listener;
  const sandbox = { CloneCore: C, window: {}, document, location: { href: 'https://www.autodl.com/create' },
    URL, console, setInterval: () => 1,
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'clone-page.js'), 'utf8'), sandbox);
  const read = () => { let result; listener({ action: 'cloneContext' }, {}, value => { result = value; }); return result; };
  assert.equal(read().success, true);
  assert.equal(read().context.mode, 'rent');
  assert.equal(read().context.regionName, '重庆A区');
  assert.equal(read().context.imageCuda, '12.4');
  document.querySelector('input[value="bj-A1"]').setAttribute('checked', '');
  assert.match(read().error, /一个具体地区/);
  document.querySelector('input[value="bj-A1"]').removeAttribute('checked');
  document.querySelector('.el-cascader input').value = '';
  assert.match(read().error, /选好基础镜像/);
  document.querySelector('input[value="basicImage"]').removeAttribute('checked');
  assert.match(read().error, /目前支持基础镜像/);
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
    if (input.type === 'checkbox') input.closest('label')?.addEventListener('click', () => input.toggleAttribute('checked'));
  }
  const sandbox = { CloneCore: C, window, document, location: { href: url }, URL, console, setInterval: () => 1,
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

async function pageWorkflow({ preview = false, available = 2, quoted = 3.96, cancelOnReserve = false, lostOnSelect = false,
  rent = false, changeImage = false, expandedDisk = false, changeOnPermit,
  imageCuda, hostCuda = '13.0', notice, noticeKind = 'notification', preexistingNotice,
  excludedHosts = [], hostCooldowns = {} } = {}) {
  const { parseHTML } = require('linkedom');
  const { document, window } = parseHTML(`<html><body>
    克隆实例仅能在同一地区内进行，以实例：source-abc的系统创建新实例
    <div class="filter-item"><span class="filter-label">选择地区:</span>
      <label>重庆A区<input type="radio" value="chongqingDC1" checked></label></div>
    ${rent ? '<div class="card image"><label><input type="radio" value="basicImage" checked>基础镜像</label><div class="el-cascader"><input value="PyTorch / 2.5 / 3.12 / CUDA 12.4"></div></div>' : ''}
    ${expandedDisk ? '<div class="el-input-number"><input value="50"></div>' : ''}
    <div class="filter-item"><span class="filter-label">GPU型号:</span>
      <label><input type="checkbox" value="RTX 4090" checked>RTX 4090</label></div>
    <div class="filter-item"><span class="filter-label">GPU数量:</span>
      <label><input type="radio" value="2" checked>2</label></div>
    <label><input type="radio" value="payg" checked>按量计费</label>
    <div class="el-table"><table><thead><tr><th class="descending">空闲GPU<i class="sort-caret descending"></i></th></tr></thead></table>
      <div class="el-table__body-wrapper"><table class="el-table__body"><tbody><tr>
        <td><input type="radio" value="host123"></td><td>123机</td>
        <td><div class="cell"><div>RTX 4090<br>24GB</div></div></td><td>${available} / 8</td>
        <td>CPU</td><td>Xeon</td><td>50GB</td><td>驱动: 580.105.08 CUDA: ${hostCuda}</td>
        <td><div class="price"><span>￥1.98</span>/时</div></td>
      </tr></tbody></table></div></div><div class="sum">
        <div class="daily-cost"><span class="pay-mode">日常费用：</span><span class="rmb">￥</span><span class="num">0.00</span><span class="unit">/日</span></div>
        <div><span class="pay-mode">配置费用：</span><span class="rmb">￥</span><span class="num">${quoted}</span><span class="unit">/时</span></div>
      </div>
      <button>创建并开机</button></body></html>`);
  window.__autodlCloneAdapter = false;
  document.querySelector('.sort-caret.descending').addEventListener('click', () =>
    document.querySelector('th').classList.toggle('descending'));
  for (const input of document.querySelectorAll('input')) {
    Object.defineProperty(input, 'checked', { get: () => input.hasAttribute('checked') });
    Object.defineProperty(input, 'disabled', { get: () => input.hasAttribute('disabled') });
  }
  document.querySelector('.el-table__body tr').addEventListener('click', () =>
    { document.querySelector('input[value="host123"]').setAttribute('checked', '');
      if (lostOnSelect) document.querySelector('.el-table__body tr').children[3].textContent = '0 / 8'; });
  const create = document.querySelector('button');
  create.getClientRects = () => [1];
  let clicks = 0;
  let reselects = 0;
  function appendNotice(value, kind = 'notification') {
    const node = document.createElement('div');
    node.className = kind === 'dialog' ? 'el-message-box' : 'el-notification';
    const content = document.createElement('div');
    content.className = kind === 'dialog' ? 'el-message-box__message' : 'el-notification__content';
    content.textContent = value; node.append(content);
    let shown = true;
    node.getClientRects = () => shown ? [1] : [];
    if (kind === 'dialog') {
      const button = document.createElement('button'); button.textContent = '重新选择';
      button.getClientRects = () => shown ? [1] : [];
      button.addEventListener('click', () => { reselects++; shown = false; node.remove(); }); node.append(button);
    }
    document.body.append(node);
  }
  if (preexistingNotice) appendNotice(preexistingNotice);
  create.addEventListener('click', () => {
    clicks++;
    if (notice) appendNotice(notice, noticeKind);
  });
  const actions = [];
  const requests = [];
  let reloadScheduled = false;
  const job = watching(preview);
  const observers = [];
  const pageUrl = rent ? 'https://www.autodl.com/create' : imageCuda ? `${url}&image_cuda=${imageCuda}` : url;
  job.context = rent ? { ...C.rentalContext(pageUrl), region: 'chongqingDC1', dataCenter: 'chongqingDC1',
    regionName: '重庆A区', imageSelection: 'PyTorch / 2.5 / 3.12 / CUDA 12.4', imageCuda: '12.4' } :
    { ...job.context, ...C.context(pageUrl), imageCuda };
  job.excludedHosts = excludedHosts; job.hostCooldowns = hostCooldowns;
  const sandbox = { CloneCore: C, window, document, location: { href: pageUrl, pathname: rent ? '/create' : '/cloneInstance', reload() {} },
    console, URL, crypto: require('node:crypto').webcrypto, Event: window.Event,
    MutationObserver: class { constructor(callback) { this.callback = callback; observers.push(this); }
      observe() { this.active = true; } disconnect() { this.active = false; } }, clearTimeout() {}, setInterval: () => 1,
    setTimeout: (fn, ms) => { if (ms >= 10000) reloadScheduled = true; else queueMicrotask(fn); return 1; },
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async request => {
      actions.push(request.action);
      requests.push(request);
      if (request.action === 'cloneError') actions.push(request.message);
      if (request.action === 'cloneJob') return { job };
      if (request.action === 'cloneReserve') {
        job.phase = cancelOnReserve ? 'stopped' : 'submitting'; job.selected = request.selected; job.attemptId = 'attempt';
        if (changeImage) document.querySelector('.el-cascader input').value = 'PyTorch / 2.6 / 3.12 / CUDA 12.4';
        return { success: true, attemptId: 'attempt' };
      }
      if (request.action === 'clonePermit') {
        if (changeOnPermit === 'image') document.querySelector('.el-cascader input').value = 'PyTorch / 2.6 / 3.12 / CUDA 12.4';
        if (changeOnPermit === 'count') document.querySelector('input[value="2"]').removeAttribute('checked');
        if (changeOnPermit === 'payg') document.querySelector('input[value="payg"]').removeAttribute('checked');
        if (changeOnPermit === 'disk') {
          const node = document.createElement('div'); node.className = 'el-input-number'; node.innerHTML = '<input value="50">'; document.body.append(node);
        }
        return { success: job.phase === 'submitting' };
      }
      if (request.action === 'cloneClicked') job.phase = 'submitted';
      if (request.action === 'cloneSubmissionRejected') job.phase = 'watching';
      return { success: true };
    } } } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'clone-page.js'), 'utf8')
    .replace('  chrome.runtime.onMessage.addListener', '  globalThis.runAdapter = run;\n  chrome.runtime.onMessage.addListener'), sandbox);
  await sandbox.runAdapter();
  return { clicks, actions, reloadScheduled, requests, job, reselects,
    emitNotice: async (value, kind) => {
      appendNotice(value, kind);
      for (const observer of observers) if (observer.active) observer.callback();
      await new Promise(resolve => setImmediate(resolve));
    } };
}
test('old preview jobs are stopped during migration instead of unexpectedly creating', async () => {
  const result = await pageWorkflow({ preview: true });
  assert.ok(result.actions.includes('cloneError'), JSON.stringify(result.actions));
  assert.equal(result.actions.includes('cloneReserve'), false);
  assert.equal(result.clicks, 0);
});

test('hourly quote ignores daily charges, balance and other currency amounts', () => {
  const { document } = require('linkedom').parseHTML(`<div class="sum">
    <div class="daily-cost"><span class="pay-mode">日常费用：</span><span class="num">0.00</span><span class="unit">/日</span></div>
    <div><span class="pay-mode">配置费用：</span><span class="rmb">￥</span><span class="num">2.19</span><span class="unit">/时</span></div>
    <div>余额 ￥199.63</div></div>`);
  assert.equal(C.hourlyQuote(document), 2.19);
  document.querySelector('.daily-cost .num').textContent = '8.00';
  assert.equal(C.hourlyQuote(document), 2.19);
  document.querySelector('.sum > div:nth-child(2) .unit').textContent = '/日';
  assert.throws(() => C.hourlyQuote(document), /小时价/);
});

test('UI exposes separate mode menus, an immediate status card and no preview checkbox', () => {
  const { document } = require('linkedom').parseHTML(fs.readFileSync(path.join(root, 'popup.html'), 'utf8'));
  assert.equal(document.querySelectorAll('[data-panel]').length, 4);
  assert.ok(document.querySelector('[data-panel="rent"]'));
  assert.ok(document.querySelector('#clonePanel #cloneStateTitle'));
  assert.ok(document.querySelector('#legacyPanel #statusText'));
  assert.ok(document.querySelector('#notificationsPanel #enableEmailNotify'));
  assert.equal(document.querySelector('#clonePreview'), null);
  const ids = Array.from(document.querySelectorAll('[id]')).map(e => e.id);
  assert.equal(new Set(ids).size, ids.length);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, C.VERSION);
  assert.ok(manifest.content_scripts.some(script => script.matches.includes('https://www.autodl.com/create') && script.js.includes('clone-page.js')));
});
test('page workflow reserves then clicks once, and cancels before click if stopped', async () => {
  const submitted = await pageWorkflow();
  assert.equal(submitted.clicks, 1, JSON.stringify(submitted.actions));
  assert.ok(submitted.actions.includes('cloneClicked'));
  const cancelled = await pageWorkflow({ cancelOnReserve: true });
  assert.equal(cancelled.clicks, 0);
});

test('rental workflow reuses filters and checkout, and refuses changed images or paid disks', async () => {
  const created = await pageWorkflow({ rent: true });
  assert.equal(created.clicks, 1, JSON.stringify(created.actions));
  assert.equal(created.job.context.mode, 'rent');
  const changed = await pageWorkflow({ rent: true, changeImage: true });
  assert.equal(changed.clicks, 0);
  assert.ok(changed.actions.some(a => /镜像发生变化/.test(a)));
  const disk = await pageWorkflow({ rent: true, expandedDisk: true });
  assert.equal(disk.clicks, 0);
  assert.equal(disk.actions.includes('cloneReserve'), false);
  const costly = await pageWorkflow({ rent: true, quoted: 5 });
  assert.equal(costly.clicks, 0);
  assert.equal(costly.actions.includes('cloneReserve'), false);
});

test('rental revalidates image, count, billing and disk after the final async permit', async () => {
  for (const changeOnPermit of ['image', 'count', 'payg', 'disk']) {
    const result = await pageWorkflow({ rent: true, changeOnPermit });
    assert.equal(result.clicks, 0, changeOnPermit);
    assert.ok(result.actions.includes('cloneReserve'), changeOnPermit);
    assert.ok(result.actions.includes('cloneError'), changeOnPermit);
  }
});

test('new minimum interval accepts 3 and 9 seconds and rejects malformed input', () => {
  assert.equal(C.options({ ...config, interval: 3 }).interval, 3);
  assert.equal(C.options({ ...config, interval: 9 }).interval, 9);
  for (const value of [0, 2, -1, 3.1, 'bad', '', Infinity]) assert.throws(() => C.options({ ...config, interval: value }));
});

test('completed rounds count once and continue increasing across worker restarts', async () => {
  const store = { cloneMonitorJob: watching() };
  const w = worker(store);
  await w.send('cloneRoundComplete', { id: 'job-1', roundId: 'round-a' });
  await w.send('cloneRoundComplete', { id: 'job-1', roundId: 'round-a' });
  assert.equal(store.cloneMonitorJob.round, 1);
  await worker(store).send('cloneRoundComplete', { id: 'job-1', roundId: 'round-b' });
  assert.equal(store.cloneMonitorJob.round, 2);
});

test('old webpage scripts cannot silently run against the new worker', async () => {
  const store = { cloneMonitorJob: watching() };
  const response = await worker(store).send('cloneJob');
  assert.equal(response.success, false);
  assert.equal(store.cloneMonitorJob.phase, 'error');
  assert.match(store.cloneMonitorJob.message, /刷新/);
});

test('losing inventory before any submission continues polling without a create click', async () => {
  const result = await pageWorkflow({ lostOnSelect: true });
  assert.equal(result.clicks, 0);
  assert.equal(result.actions.includes('cloneReserve'), false);
  assert.equal(result.actions.includes('cloneError'), false);
  assert.ok(result.reloadScheduled);
});

test('pre-click reservation release is attempt-scoped and cannot release clicked requests', async () => {
  const store = { cloneMonitorJob: watching() };
  const w = worker(store);
  const permit = await w.send('cloneReserve', { id: 'job-1', selected });
  assert.equal((await w.send('cloneAbortBeforeClick', { id: 'job-1', attemptId: 'wrong' })).success, false);
  assert.equal((await w.send('cloneAbortBeforeClick', { id: 'job-1', attemptId: permit.attemptId })).success, true);
  assert.equal(store.cloneMonitorJob.phase, 'watching');
  const next = await w.send('cloneReserve', { id: 'job-1', selected });
  await w.send('cloneClicked', { id: 'job-1', attemptId: next.attemptId });
  assert.equal((await w.send('cloneAbortBeforeClick', { id: 'job-1', attemptId: next.attemptId })).success, false);
  assert.equal(store.cloneMonitorJob.phase, 'submitted');
});

test('new submission errors are retained without unlocking an ambiguous billable request', async () => {
  const store = { cloneMonitorJob: watching() };
  const w = worker(store);
  const permit = await w.send('cloneReserve', { id: 'job-1', selected });
  await w.send('cloneClicked', { id: 'job-1', attemptId: permit.attemptId });
  await w.send('cloneSubmissionNotice', { id: 'job-1', attemptId: permit.attemptId, notice: '测试：GPU资源发生变化' });
  assert.equal(store.cloneMonitorJob.lastSubmissionNotice, '测试：GPU资源发生变化');
  assert.equal(store.cloneMonitorJob.phase, 'submitted');
  assert.equal((await w.send('cloneReserve', { id: 'job-1', selected })).success, false);
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

const cudaNotice = '镜像的CUDA版本高于主机支持的最高CUDA版本，将导致无法开机，请重新选择主机/镜像';
const stockNotice = 'GPU库存发生变更，请刷新后重新选择';

test('CUDA comparisons use major/minor versions and preserve unknown values', () => {
  assert.equal(C.cudaCompatible('12.8', '12.4'), false);
  assert.equal(C.cudaCompatible('12.8', '13.0'), true);
  assert.equal(C.cudaCompatible('12.10', '12.9'), false);
  assert.equal(C.cudaCompatible('13.0', '13.0'), true);
  assert.equal(C.cudaCompatible('12.8', null), null);
  assert.equal(C.cudaCompatible(null, '12.4'), null);
  assert.equal(C.eligible({ ...machine, cuda: '12.4' }, config, '12.8'), false);
  assert.equal(C.cudaRejected(cudaNotice), true);
  assert.equal(C.stockRejected(stockNotice), true);
  assert.equal(C.stockRejected('请求超时，GPU库存发生变更，请刷新后重新选择'), false);
  assert.equal(C.stockRejected('GPU资源发生变化'), false);
});

test('page skips known incompatible, excluded and cooling-down hosts before a billable click', async () => {
  for (const options of [{ imageCuda: '12.8', hostCuda: '12.4' }, { excludedHosts: ['host123'] },
    { hostCooldowns: { host123: Date.now() + 30000 } }]) {
    const result = await pageWorkflow(options);
    assert.equal(result.clicks, 0);
    assert.equal(result.actions.includes('cloneReserve'), false);
    assert.equal(result.actions.includes('cloneError'), false);
  }
  assert.equal((await pageWorkflow({ imageCuda: '12.8', hostCuda: '13.0' })).clicks, 1);
});

test('page captures plain Element UI notifications and resumes only exact stock rejection', async () => {
  const rejected = await pageWorkflow({ notice: stockNotice });
  assert.equal(rejected.clicks, 1);
  assert.ok(rejected.actions.includes('cloneSubmissionRejected'));
  assert.equal(rejected.requests.find(r => r.action === 'cloneSubmissionRejected').reason, 'stock');
  assert.equal(rejected.job.phase, 'watching');
  const unknown = await pageWorkflow({ notice: '订单处理异常，请联系管理员\n请求编号：example' });
  assert.equal(unknown.clicks, 1);
  assert.equal(unknown.actions.includes('cloneSubmissionRejected'), false);
  assert.equal(unknown.job.phase, 'submitted');
  const feedback = unknown.requests.find(r => r.action === 'cloneSubmissionNotice');
  assert.equal(feedback.notice, '订单处理异常，请联系管理员\n请求编号：example');
  assert.equal(feedback.noticeKind, 'notification');
});

test('CUDA modal reselects and resumes; unknown modal is recorded without pressing its button', async () => {
  const rejected = await pageWorkflow({ notice: cudaNotice, noticeKind: 'dialog' });
  assert.equal(rejected.reselects, 1);
  assert.equal(rejected.job.phase, 'watching');
  assert.equal(rejected.requests.find(r => r.action === 'cloneSubmissionRejected').reason, 'cuda');
  const unknown = await pageWorkflow({ notice: '需要额外确认费用', noticeKind: 'dialog' });
  assert.equal(unknown.reselects, 0);
  assert.equal(unknown.job.phase, 'submitted');
  assert.equal(unknown.requests.find(r => r.action === 'cloneSubmissionNotice').notice, '需要额外确认费用');
});

test('worker whitelists attempt-scoped rejections, persists CUDA exclusions and stock cooldowns', async () => {
  for (const reason of ['cuda', 'stock']) {
    const store = { cloneMonitorJob: watching() };
    const w = worker(store);
    const permit = await w.send('cloneReserve', { id: 'job-1', selected });
    await w.send('cloneClicked', { id: 'job-1', attemptId: permit.attemptId });
    const request = { id: 'job-1', adapterVersion: C.VERSION, attemptId: permit.attemptId,
      candidateId: selected.id, reason, notice: reason === 'cuda' ? cudaNotice : stockNotice };
    assert.equal((await w.send('cloneSubmissionRejected', { ...request, attemptId: 'stale' })).success, false);
    assert.equal((await w.send('cloneSubmissionRejected', { ...request, notice: '未知错误' })).success, false);
    assert.equal((await w.send('cloneSubmissionRejected', request, 8)).success, false);
    assert.equal((await w.send('cloneSubmissionRejected', request)).success, true);
    assert.equal(store.cloneMonitorJob.phase, 'watching');
    assert.equal(store.cloneMonitorJob.attemptId, null);
    if (reason === 'cuda') assert.ok(store.cloneMonitorJob.excludedHosts.includes(selected.id));
    else assert.ok(store.cloneMonitorJob.hostCooldowns[selected.id] > Date.now());
    assert.equal((await worker(store).send('cloneReserve', { id: 'job-1', selected })).success, false);
    const next = await w.send('cloneReserve', { id: 'job-1', selected: { ...selected, id: 'another-host' } });
    assert.equal(next.success, true);
    assert.equal(store.cloneMonitorJob.lastSubmissionNotice, null, 'new attempt must not display a prior rejection as current feedback');
    assert.equal((await w.send('cloneSubmissionRejected', request)).success, false);
    assert.equal(store.cloneMonitorJob.attemptId, next.attemptId);
  }
});

test('unknown submission feedback is persisted with full bounded text and attempt provenance', async () => {
  const store = { cloneMonitorJob: watching() }, w = worker(store);
  const permit = await w.send('cloneReserve', { id: 'job-1', selected });
  await w.send('cloneClicked', { id: 'job-1', attemptId: permit.attemptId });
  const notice = '尚未适配的提示：\n' + '排查内容'.repeat(300);
  await w.send('cloneSubmissionNotice', { id: 'job-1', attemptId: permit.attemptId, notice, noticeKind: 'dialog' });
  const exported = await w.send('diagnosticRead');
  const record = exported.log.entries.find(e => e.event === 'submit.feedback');
  assert.equal(record.details.notice, notice);
  assert.equal(record.details.attemptId, permit.attemptId);
  assert.equal(record.details.candidateId, selected.id);
  assert.equal(record.details.noticeKind, 'dialog');
  assert.equal(store.cloneMonitorJob.phase, 'submitted');
});

test('late unknown feedback is observed and old identical toasts cannot hide fresh stock rejection', async () => {
  const late = await pageWorkflow();
  await late.emitNotice('延迟返回的新错误：example', 'dialog');
  assert.equal(late.requests.find(r => r.action === 'cloneSubmissionNotice').notice, '延迟返回的新错误：example');
  assert.equal(late.job.phase, 'submitted');
  const old = await pageWorkflow({ preexistingNotice: stockNotice });
  assert.equal(old.actions.includes('cloneSubmissionRejected'), false);
  const fresh = await pageWorkflow({ preexistingNotice: stockNotice, notice: stockNotice });
  assert.ok(fresh.actions.includes('cloneSubmissionRejected'));
});

test('stock cooldown expires but an observed new instance or unknown rejection never unlocks a request', async () => {
  const store = { cloneMonitorJob: { ...watching(), hostCooldowns: { [selected.id]: Date.now() - 1 } } };
  const w = worker(store);
  const permit = await w.send('cloneReserve', { id: 'job-1', selected });
  assert.equal(permit.success, true);
  await w.send('cloneClicked', { id: 'job-1', attemptId: permit.attemptId });
  const request = { id: 'job-1', adapterVersion: C.VERSION, attemptId: permit.attemptId,
    candidateId: selected.id, reason: 'stock', notice: stockNotice };
  store.cloneMonitorJob.newInstanceId = 'already-created';
  assert.equal((await w.send('cloneSubmissionRejected', request)).success, false);
  assert.equal(store.cloneMonitorJob.phase, 'submitted');
  delete store.cloneMonitorJob.newInstanceId;
  assert.equal((await w.send('cloneSubmissionRejected', { ...request, adapterVersion: 'old' })).success, false);
  assert.equal((await w.send('cloneSubmissionRejected', { ...request, reason: 'unknown' })).success, false);
});
