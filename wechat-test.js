/* Personal test-account notifications; credentials never enter diagnostic logs. */
(function (root) {
  'use strict';
  const KEY = 'wechatTestSettings';
  function validate(input) {
    const config = {};
    for (const name of ['appId', 'appSecret', 'openId', 'templateId']) {
      config[name] = String(input?.[name] || '').trim();
      if (!config[name] || config[name].length > 256 || /\s/.test(config[name])) {
        throw new Error(`请正确填写 ${name === 'appSecret' ? 'AppSecret' : name}`);
      }
    }
    return config;
  }
  function apiError(code) {
    const hint = { 40013: 'AppID 无效', 40125: 'AppSecret 无效', 40164: '请在微信后台配置当前出口 IP 白名单',
      40003: 'OpenID 无效，请复制关注用户列表中的用户标识', 40037: '模板 ID 无效',
      43004: '接收用户尚未关注该测试号', 45009: '已达到微信接口调用额度',
      48001: '该账号没有此接口权限', 41001: '接口凭证缺失',
      40001: '接口凭证无效', 40014: '接口凭证无效', 42001: '接口凭证过期' };
    return new Error(`微信接口错误 ${Number.isFinite(Number(code)) ? Number(code) : '未知'}：${hint[code] || '请核对测试号权限、模板及配置'}`);
  }
  function createWechatTestSender(fetcher = fetch, now = Date.now) {
    let cache;
    let tokenPending;
    async function request(url, init = {}) {
      let response;
      try { response = await fetcher(url, { ...init, signal: AbortSignal.timeout(15000) }); }
      catch { throw new Error('微信接口连接失败或超时；请检查网络，发送请求超时可能已被接受'); }
      if (!response.ok) throw new Error(`微信接口 HTTP ${response.status}`);
      try { return await response.json(); } catch { throw new Error('微信接口返回格式异常'); }
    }
    async function token(config) {
      const identity = `${config.appId}:${config.appSecret}`;
      if (cache?.identity === identity && now() < cache.expiresAt) return cache.token;
      // Serialize token acquisition for one app to avoid invalidating concurrent sends.
      if (tokenPending) { await tokenPending; return token(config); }
      tokenPending = (async () => {
        const query = new URLSearchParams({ grant_type: 'client_credential', appid: config.appId, secret: config.appSecret });
        const result = await request(`https://api.weixin.qq.com/cgi-bin/token?${query}`);
        if (!result.access_token) throw apiError(result.errcode);
        cache = { identity, token: result.access_token,
          expiresAt: now() + Math.max(0, Number(result.expires_in || 7200) - 120) * 1000 };
        return cache.token;
      })();
      try { return await tokenPending; } finally { tokenPending = undefined; }
    }
    async function send(settings, message) {
      const config = validate(settings);
      const body = JSON.stringify({ touser: config.openId, template_id: config.templateId,
        data: {
          title: { value: String(message.title || 'AutoDL 通知').slice(0, 100) },
          content: { value: String(message.content || '').slice(0, 1000) },
          time: { value: new Date(now()).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) }
        } });
      for (let attempt = 0; attempt < 2; attempt++) {
        const credential = await token(config);
        const result = await request(`https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=${encodeURIComponent(credential)}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        if (result.errcode === 0) return { success: true };
        if (!attempt && [40001, 40014, 42001].includes(result.errcode)) { cache = undefined; continue; }
        throw apiError(result.errcode);
      }
    }
    return { send, clear: () => { cache = undefined; } };
  }
  root.WechatTest = { KEY, validate, createWechatTestSender };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.WechatTest;
})(globalThis);
