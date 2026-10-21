const test = require('node:test');
const assert = require('node:assert/strict');
const { createWechatTestSender, validate } = require('../wechat-test.js');
const config = { appId: 'wx-app', appSecret: 'secret', openId: 'user-openid', templateId: 'template' };
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const ok = value => ({ ok: true, json: async () => value });
test('WeChat template sends correct user and fields and caches token', async () => {
  const calls = [];
  const sender = createWechatTestSender(async (url, init) => {
    calls.push({ url, init });
    return ok(url.includes('/token?') ? { access_token: 'token', expires_in: 7200 } : { errcode: 0 });
  });
  await sender.send(config, { title: '测试', content: '内容' });
  await sender.send(config, { title: '开机成功', content: '实例' });
  assert.equal(calls.length, 3);
  const payload = JSON.parse(calls[1].init.body);
  assert.equal(payload.touser, config.openId);
  assert.equal(payload.template_id, config.templateId);
  assert.equal('url' in payload, false, 'notification text must not link to the AutoDL console');
  assert.equal('miniprogram' in payload, false);
  assert.deepEqual(Object.keys(payload.data), ['title', 'content', 'time']);
  assert.equal(payload.data.content.value, '内容');
});
test('only explicit invalid-token responses retry once; config changes acquire own token', async () => {
  const values = [{ access_token: 'old' }, { errcode: 42001 }, { access_token: 'fresh' }, { errcode: 0 },
    { access_token: 'another' }, { errcode: 0 }];
  const calls = [];
  const sender = createWechatTestSender(async url => { calls.push(url); return ok(values.shift()); });
  await sender.send(config, {});
  await sender.send({ ...config, appSecret: 'changed' }, {});
  assert.equal(calls.filter(url => url.includes('/token?')).length, 3);
});
test('timeouts do not resend and network error cannot disclose credentials', async () => {
  let count = 0;
  const sender = createWechatTestSender(async url => {
    count++;
    if (count === 1) return ok({ access_token: 'private-token' });
    throw new Error(url + config.appSecret);
  });
  await assert.rejects(sender.send(config, {}), error => {
    assert.match(error.message, /超时/);
    assert.ok(!error.message.includes('private-token'));
    assert.ok(!error.message.includes(config.appSecret));
    return true;
  });
  assert.equal(count, 2);
});
test('WeChat quota and recipient errors remain explicit and never trigger resends', async () => {
  for (const code of [45009, 40003, 40037, 43004, 40164]) {
    let calls = 0;
    const sender = createWechatTestSender(async url => { calls++; return ok(url.includes('/token?') ? { access_token: 'token' } : { errcode: code, errmsg: 'secret-raw-details' }); });
    await assert.rejects(sender.send(config, {}), error => error.message.includes(String(code)) && !error.message.includes('secret-raw-details'));
    assert.equal(calls, 2);
  }
  assert.throws(() => validate({}), /填写/);
});
test('token expiry refreshes; concurrent sends share token acquisition', async () => {
  let clock = 0, tokens = 0;
  const sender = createWechatTestSender(async url => {
    if (url.includes('/token?')) { tokens++; await Promise.resolve(); return ok({ access_token: 'token', expires_in: 7200 }); }
    return ok({ errcode: 0 });
  }, () => clock);
  await Promise.all([sender.send(config, {}), sender.send(config, {})]);
  assert.equal(tokens, 1);
  clock = 7200 * 1000;
  await sender.send(config, {});
  assert.equal(tokens, 2);
  sender.clear(); await sender.send(config, {});
  assert.equal(tokens, 3);
});
test('worker enables notifications only when configured and supports popup test without leaking settings', async () => {
  let listener, count = 0;
  const logs = [], store = { wechatTestSettings: { ...config, enabled: false } };
  const sandbox = { importScripts() {},
    WechatTest: { ...require('../wechat-test.js'), createWechatTestSender: () => ({ send: async () => { count++; }, clear() {} }) },
    diagnosticLog: { append: async (...args) => logs.push(args) },
    chrome: { storage: { local: { get: async () => store }, onChanged: { addListener() {} } },
      runtime: { onMessage: { addListener: fn => { listener = fn; } } } }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'wechat-test-background.js'), 'utf8'), sandbox);
  await sandbox.sendWechatTestNotification({ title: '开机' }); assert.equal(count, 0);
  const result = await new Promise(resolve => listener({ action: 'wechatTestSend' }, {}, resolve));
  assert.equal(result.success, true); assert.equal(count, 1);
  assert.equal(listener({ action: 'wechatTestSend' }, { tab: { id: 7 } }, () => {}), undefined);
  store.wechatTestSettings.enabled = true;
  await sandbox.sendWechatTestNotification({ title: '开机' }); assert.equal(count, 2);
  assert.ok(!JSON.stringify(logs).includes('secret'));
  const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  assert.match(background, /async function sendEmailNotification\(instanceData\)\s*\{\s*try\s*\{\s*await sendWechatTestNotification/);
});
test('popup loads and saves local credentials, sends test and clears settings', async () => {
  const { parseHTML } = require('linkedom');
  const { document, window } = parseHTML(fs.readFileSync(path.join(root, 'popup.html'), 'utf8'));
  const store = { wechatTestSettings: { ...config, enabled: true } };
  let sends = 0;
  const sandbox = { document, window, WechatTest: require('../wechat-test.js'), chrome: {
    storage: { local: { get: async () => structuredClone(store), set: async value => Object.assign(store, structuredClone(value)),
      remove: async key => { delete store[key]; } } },
    runtime: { sendMessage: async request => { assert.equal(request.action, 'wechatTestSend'); sends++; return { success: true }; } }
  } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'wechat-test-popup.js'), 'utf8'), sandbox);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(document.getElementById('wechat-appSecret').value, 'secret');
  assert.equal(document.getElementById('wechatTestConfig').hidden, false);
  document.getElementById('wechatTestSend').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sends, 1);
  assert.match(document.getElementById('wechatTestStatus').textContent, /接口已接受/);
  await window.clearWechatTestSettings();
  assert.equal(store.wechatTestSettings, undefined);
  assert.equal(document.getElementById('wechat-appSecret').value, '');
});
