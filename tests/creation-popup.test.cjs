const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const C = require('../clone-core.js');
const root = path.join(__dirname, '..');
const flush = () => new Promise(resolve => setImmediate(resolve));

async function popup({ failRead = false, priorJob } = {}) {
  const { document, window } = require('linkedom').parseHTML(fs.readFileSync(path.join(root, 'popup.html'), 'utf8'));
  const store = { popupPanel: 'rent',
    cloneSettings: { models: ['RTX 4090'], count: 1, maxPrice: 4, interval: 5 },
    rentSettings: { models: ['RTX 4090'], count: 2, maxPrice: 3, interval: 3 } };
  const requests = [];
  let job = priorJob, tabUrl = 'https://www.autodl.com/create';
  const context = () => tabUrl.endsWith('/create') ? {
    ...C.rentalContext(tabUrl), regionName: '西北B区', region: 'xb-B', dataCenter: 'xb-B',
    imageSelection: 'PyTorch / 2.5 / 3.12 / CUDA 12.4', imageCuda: '12.4', models: ['RTX 4090'], adapterVersion: C.VERSION
  } : { ...C.context(tabUrl), regionName: '西北B区', models: ['RTX 4090'], adapterVersion: C.VERSION };
  Object.defineProperty(document.getElementById('cloneCount'), 'value', { value: '1', writable: true });
  Object.defineProperty(document.getElementById('cloneModels'), 'selectedOptions', {
    get() { return Array.from(this.querySelectorAll('option')).filter(e => e.selected); }
  });
  for (const id of ['cloneMaxPrice', 'cloneInterval']) document.getElementById(id).reportValidity = () => true;
  const sandbox = { document, window: { scrollTo() {} }, CustomEvent: window.CustomEvent,
    CloneCore: C, setInterval() {}, persistNotifySettingsFromUI: async () => {}, chrome: {
      tabs: { query: async () => [{ id: 7, url: tabUrl }], sendMessage: async () => {
        if (failRead) throw new Error('Could not establish connection. Receiving end does not exist.');
        return { success: true, context: context() };
      } },
      storage: { local: { get: async key => ({ [key]: store[key] }), set: async values => Object.assign(store, values) },
        onChanged: { addListener() {} } },
      runtime: { sendMessage: async request => {
        requests.push(request);
        if (request.action === 'cloneStart') job = { id: 'new-job', phase: 'watching', round: 0,
          context: context(), config: request.config, message: '新租监控已开启' };
        return { success: true, job };
      } }
    } };
  vm.createContext(sandbox);
  for (const file of ['clone-popup.js', 'popup-navigation.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox);
  await flush();
  return { document, store, requests, setTab: url => { tabUrl = url; } };
}

test('new-rental menu restores separate settings and starts with the selected mode', async () => {
  const { document, store, requests, setTab } = await popup();
  assert.equal(document.querySelector('[data-panel="rent"]').getAttribute('aria-selected'), 'true');
  assert.equal(document.getElementById('clonePanel').hidden, false);
  assert.equal(document.getElementById('legacyPanel').hidden, true);
  assert.match(document.getElementById('cloneSource').textContent, /PyTorch/);
  assert.equal(document.getElementById('cloneMaxPrice').value, '3');
  document.getElementById('cloneMaxPrice').value = '2.8';
  document.querySelector('[data-panel="notifications"]').click();
  document.querySelector('[data-panel="rent"]').click();
  await flush();
  assert.equal(document.getElementById('cloneMaxPrice').value, '2.8', 'returning from notifications preserves edits');
  setTab('https://www.autodl.com/cloneInstance?id=src-abc&region=xb-B&copy_data_disk=1');
  document.querySelector('[data-panel="clone"]').click();
  await flush();
  assert.equal(document.getElementById('cloneMaxPrice').value, '4');
  assert.match(document.getElementById('cloneSource').textContent, /src-abc/);
  setTab('https://www.autodl.com/create');
  document.querySelector('[data-panel="rent"]').click();
  await flush();
  document.getElementById('cloneStart').click();
  await flush();
  const start = requests.find(r => r.action === 'cloneStart');
  assert.equal(start.mode, 'rent');
  assert.equal(start.config.maxPrice, 3);
  assert.equal(start.config.count, 2);
  assert.equal(store.cloneSettings.maxPrice, 4);
  assert.equal(store.rentSettings.maxPrice, 3);
  assert.match(document.getElementById('cloneStateTitle').textContent, /新租/);
  document.querySelector('[data-panel="legacy"]').click();
  assert.equal(document.getElementById('clonePanel').hidden, true);
  assert.equal(document.getElementById('legacyPanel').hidden, false);
  assert.equal(requests.some(r => r.action === 'cloneStop'), false);
});

test('read failure does not mislabel an old successful task as stopped at its old round', async () => {
  const { document, requests } = await popup({ failRead: true,
    priorJob: { id: 'old-job', phase: 'success', round: 42, message: '上次创建成功' } });
  document.getElementById('cloneRead').click();
  await flush();
  assert.equal(document.getElementById('cloneStateTitle').textContent, '页面读取失败');
  assert.match(document.getElementById('cloneStatus').textContent, /刷新/);
  assert.equal(document.getElementById('cloneRunDetails').textContent, '');
  assert.equal(requests.some(r => r.action === 'cloneStop'), false);
});
