/* Shared validation for clone monitoring. No account credentials are read here. */
(function (root) {
  'use strict';
  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
  function context(url) {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://www.autodl.com' || parsed.pathname !== '/cloneInstance') {
      throw new Error('请先从已关机的源实例进入“克隆实例”页面');
    }
    const sourceId = parsed.searchParams.get('id');
    const region = parsed.searchParams.get('region');
    if (!sourceId || !region || parsed.searchParams.get('copy_data_disk') !== '1') {
      throw new Error('缺少源实例、地区或数据盘复制参数；请重新进入克隆流程并勾选数据盘');
    }
    if (!/^[\w-]+$/.test(sourceId) || !/^[\w-]+$/.test(region)) throw new Error('源实例或地区参数格式不正确');
    return { sourceId, region, url: parsed.href };
  }
  function options(input) {
    const models = [...new Set((input.models || []).map(normalize).filter(Boolean))];
    const count = Number(input.count);
    const maxPrice = Number(input.maxPrice);
    const interval = Number(input.interval);
    if (!models.length || models.some(m => m === '全部' || m === 'CPU')) throw new Error('请选择至少一种 GPU 型号');
    if (![1, 2, 3, 4, 5, 6, 7, 8, 10, 12].includes(count)) throw new Error('GPU 数量不正确');
    if (!Number.isFinite(maxPrice) || maxPrice <= 0) throw new Error('请输入整台实例每小时价格上限');
    if (!Number.isInteger(interval) || interval < 10 || interval > 3600) throw new Error('检查间隔为 10–3600 秒');
    return { models, count, maxPrice, interval, preview: input.preview !== false };
  }
  function money(text) {
    const match = normalize(text).match(/[￥¥]\s*([\d,]+(?:\.\d+)?)/);
    return match ? Number(match[1].replace(/,/g, '')) : NaN;
  }
  function eligible(machine, config) {
    return !!machine.id && config.models.includes(normalize(machine.model)) &&
      Number.isInteger(machine.available) && machine.available >= config.count &&
      machine.enabled === true && Number.isFinite(machine.price) && machine.price > 0 &&
      Math.round(machine.price * 100) * config.count <= Math.round(config.maxPrice * 100);
  }
  function assertContext(actual, expected) {
    if (actual.sourceId !== expected.sourceId || actual.region !== expected.region || actual.url !== expected.url) {
      throw new Error('源实例、地区或克隆页面参数发生变化，已停止');
    }
  }
  const api = { normalize, context, options, money, eligible, assertContext };
  root.CloneCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
