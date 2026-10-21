importScripts('wechat-test.js');
const wechatTestSender = WechatTest.createWechatTestSender();
async function sendWechatTestNotification(message, testing = false) {
  const settings = (await chrome.storage.local.get(WechatTest.KEY))[WechatTest.KEY];
  if (!testing && !settings?.enabled) return;
  try {
    await wechatTestSender.send(settings, message);
    await diagnosticLog.append('wechat.test.accepted', { message: testing ? '测试通知已被微信接口接受' : '开机通知已被微信接口接受' });
  } catch (error) {
    await diagnosticLog.append('wechat.test.failed', { message: error.message }, 'error');
    throw error;
  }
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[WechatTest.KEY]) wechatTestSender.clear();
});
chrome.runtime.onMessage.addListener((request, sender, respond) => {
  if (request.action !== 'wechatTestSend' || sender.tab) return;
  sendWechatTestNotification({ title: 'AutoDL 测试通知', content: '通知配置成功',
    host: '测试主机（非真实实例）', instanceId: 'test-instance', spec: 'RTX 4090 × 1（示例）' }, true)
    .then(() => respond({ success: true }), error => respond({ success: false, error: error.message }));
  return true;
});
