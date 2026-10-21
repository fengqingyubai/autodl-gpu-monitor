(() => {
  const $ = id => document.getElementById(id);
  const names = ['appId', 'appSecret', 'openId', 'templateId'];
  const status = $('wechatTestStatus');
  const enabled = $('wechatTestEnabled');
  let ready = false;
  window.saveWechatTestSettings = async () => {
    if (!ready) throw new Error('微信配置尚未加载，请稍后再试');
    const values = { enabled: enabled.checked };
    for (const name of names) values[name] = $(`wechat-${name}`).value.trim();
    await chrome.storage.local.set({ wechatTestSettings: values });
    return values;
  };
  const show = () => { $('wechatTestConfig').hidden = !enabled.checked; };
  chrome.storage.local.get('wechatTestSettings').then(result => {
    const config = result.wechatTestSettings || {};
    enabled.checked = !!config.enabled;
    for (const name of names) $(`wechat-${name}`).value = config[name] || '';
    ready = true; enabled.disabled = false;
    for (const name of names) $(`wechat-${name}`).disabled = false;
    $('wechatTestSend').disabled = false; show();
  }).catch(() => { status.textContent = '配置读取失败，请重新打开插件'; });
  enabled.addEventListener('change', () => { show(); window.saveWechatTestSettings().catch(error => { status.textContent = error.message; }); });
  for (const name of names) $(`wechat-${name}`).addEventListener('blur', () => {
    window.saveWechatTestSettings().catch(error => { status.textContent = error.message; });
  });
  window.clearWechatTestSettings = async () => {
    await chrome.storage.local.remove('wechatTestSettings');
    enabled.checked = false;
    for (const name of names) $(`wechat-${name}`).value = '';
    status.textContent = ''; show();
  };
  $('wechatTestSend').addEventListener('click', async () => {
    const button = $('wechatTestSend'); button.disabled = true; status.textContent = '正在发送…';
    try {
      WechatTest.validate(await window.saveWechatTestSettings());
      const result = await chrome.runtime.sendMessage({ action: 'wechatTestSend' });
      if (!result?.success) throw new Error(result?.error || '扩展后台未响应，请重新加载插件');
      status.textContent = '微信接口已接受，请检查手机是否收到，以及三个模板字段是否显示完整。';
    } catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  });
})();
