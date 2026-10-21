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
  sendWechatTestNotification({ title: 'AutoDL 测试通知', content: '这是一条测试消息。收到后，说明微信测试号通知配置可用。' }, true)
    .then(() => respond({ success: true }), error => respond({ success: false, error: error.message }));
  return true;
});
