/* Persistent one-shot submission and status tracking; imported by background.js. */
importScripts('clone-core.js');
const CLONE_JOB_KEY = 'cloneMonitorJob';
let cloneQueue = Promise.resolve();
const cloneWait = ms => new Promise(resolve => setTimeout(resolve, ms));
const readCloneJob = async () => (await chrome.storage.local.get(CLONE_JOB_KEY))[CLONE_JOB_KEY];
async function saveCloneJob(job) {
  await chrome.storage.local.set({ [CLONE_JOB_KEY]: { ...job, updatedAt: Date.now() } });
}
async function cloneNotice(title, message) {
  await chrome.notifications.create({ type: 'basic', iconUrl: 'icon128.png', title, message });
}
async function sendClonePage(tabId, message) {
  const result = await chrome.tabs.sendMessage(tabId, message);
  if (!result?.success) throw new Error(result?.error || '页面未响应，请刷新 AutoDL 页面');
  return result;
}
async function snapshotInstances() {
  const tab = await chrome.tabs.create({ url: 'https://www.autodl.com/console/instance/list', active: false });
  try {
    for (let i = 0; i < 50; i++) {
      await cloneWait(300);
      const live = await chrome.tabs.get(tab.id);
      if (live.status !== 'complete') continue;
      if (!live.url?.startsWith('https://www.autodl.com/console/instance/list')) throw new Error('AutoDL 登录状态已过期');
      try { return (await sendClonePage(tab.id, { action: 'cloneListSnapshot' })).instances; }
      catch (error) { if (i === 49) throw error; }
    }
    throw new Error('实例列表读取超时');
  } finally { await chrome.tabs.remove(tab.id).catch(() => {}); }
}
function stopLegacyMonitor() {
  monitoringEnabled = false;
  if (intervalId) { clearInterval(intervalId); intervalId = null; }
}
function cloneActive(job) { return job && ['watching', 'submitting', 'submitted'].includes(job.phase); }
async function handleCloneMessage(request, sender) {
  let job = await readCloneJob();
  if (request.action === 'cloneStatus') return { success: true, job };
  if (request.action === 'cloneStart') {
    if (cloneActive(job)) throw new Error('已有克隆任务，请先停止；已提交的任务需核实后解除锁定');
    if (job?.phase === 'uncertain') throw new Error('上次提交结果未确认，请先核实实例列表并解除提交锁定');
    if (checkInProgress) throw new Error('原开关机操作仍在执行，请稍后再开始克隆');
    const cfg = CloneCore.options(request.config);
    const { context } = await sendClonePage(request.tabId, { action: 'cloneContext' });
    if (cfg.models.some(model => !context.models.includes(model))) throw new Error('所选 GPU 型号不属于源实例地区');
    stopLegacyMonitor();
    legacyCloneLocked = true;
    let baseline;
    try { baseline = await snapshotInstances(); }
    catch (error) { legacyCloneLocked = false; throw error; }
    const source = baseline.find(instance => instance.id === context.sourceId);
    if (!source || !source.status.includes('已关机') || source.region !== context.regionName) {
      legacyCloneLocked = false;
      throw new Error('源实例必须已关机，且必须属于克隆页面所选地区');
    }
    stopLegacyMonitor();
    job = { id: crypto.randomUUID(), phase: 'watching', tabId: request.tabId, context,
      config: cfg, baseline: baseline.map(instance => instance.id), createdAt: Date.now(),
      message: cfg.preview ? '预览模式：仅筛选和选中主机，不会提交' : '正在扫描同地区可用主机' };
    await saveCloneJob(job);
    await chrome.alarms.create('clone-watchdog', { periodInMinutes: 0.5 });
    await sendClonePage(job.tabId, { action: 'cloneRun' });
    return { success: true, job };
  }
  if (request.action === 'cloneStop') {
    if (job) {
      const uncertain = ['submitting', 'submitted', 'uncertain'].includes(job.phase);
      await saveCloneJob({ ...job, phase: uncertain ? 'uncertain' : 'stopped',
        message: uncertain ? '已停止跟踪；可能已提交，请核实控制台后解除锁定' : '已停止，不会创建新实例' });
    }
    return { success: true };
  }
  if (request.action === 'cloneUnlock') {
    if (job && ['uncertain', 'submitted'].includes(job.phase)) {
      await saveCloneJob({ ...job, phase: 'stopped', message: '用户已核实提交结果并解除锁定' });
    }
    return { success: true };
  }
  // Page actions must come from the exact monitored tab and job, never from another instance tab.
  if (!job || job.id !== request.id && request.action !== 'cloneJob' || sender.tab?.id !== job.tabId) {
    return { success: false, error: '不是当前克隆任务' };
  }
  if (request.action === 'cloneJob') return { success: true, job };
  if (request.action === 'clonePermit') return { success: job.phase === 'submitting' };
  if (request.action === 'cloneClicked') {
    if (job.phase === 'submitting') await saveCloneJob({ ...job, phase: 'submitted',
      submittedAt: Date.now(), message: '已点击创建并开机；正在核实新实例，绝不重复提交' });
    return { success: true };
  }
  if (request.action === 'cloneError') {
    if (cloneActive(job)) {
      const uncertain = ['submitting', 'submitted'].includes(job.phase);
      await saveCloneJob({ ...job, phase: uncertain ? 'uncertain' : 'error', message: request.message });
      await cloneNotice('AutoDL 克隆监控已停止', request.message);
    }
    return { success: true };
  }
  if (job.phase !== 'watching') return { success: false, error: '任务已停止或已提交' };
  if (request.action === 'cloneProgress') {
    await saveCloneJob({ ...job, message: request.message });
  } else if (request.action === 'clonePreview') {
    await saveCloneJob({ ...job, phase: 'preview', selected: request.selected,
      message: `已选中 ${request.selected.name} ${request.selected.model}，总价 ￥${request.selected.total}/小时。预览完成，未提交。` });
    await cloneNotice('AutoDL 克隆预览完成', `${request.selected.name}，￥${request.selected.total}/小时；未创建实例`);
  } else if (request.action === 'cloneReserve') {
    if (job.config.preview) throw new Error('预览任务禁止提交');
    if (!request.selected?.id || !job.config.models.includes(request.selected.model) ||
        !Number.isFinite(request.selected.total) || !Number.isFinite(request.selected.price) ||
        request.selected.total > job.config.maxPrice || request.selected.total <= 0 ||
        Math.abs(request.selected.total - request.selected.price * job.config.count) > 0.011) throw new Error('提交参数不符合限制');
    await saveCloneJob({ ...job, phase: 'submitting', selected: request.selected,
      submittedAt: Date.now(), message: '提交锁定中，刷新或重启也不会重复创建' });
  }
  return { success: true };
}
chrome.runtime.onMessage.addListener((request, sender, respond) => {
  const actions = ['cloneStatus', 'cloneStart', 'cloneStop', 'cloneUnlock', 'cloneJob', 'clonePermit',
    'cloneProgress', 'clonePreview', 'cloneReserve', 'cloneClicked', 'cloneError'];
  if (!actions.includes(request.action)) return false;
  // Serialize reserve, stop and progress mutations, including across different tabs.
  cloneQueue = cloneQueue.then(() => handleCloneMessage(request, sender))
    .then(respond, error => respond({ success: false, error: error.message }));
  return true;
});
let cloneTracking = false;
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== 'clone-watchdog' || cloneTracking) return;
  cloneTracking = true;
  try {
    let job = await readCloneJob();
    if (!cloneActive(job)) { await chrome.alarms.clear('clone-watchdog'); return; }
    if (job.phase === 'watching') {
      const tab = await chrome.tabs.get(job.tabId).catch(() => null);
      if (!tab || tab.url !== job.context.url) {
        cloneQueue = cloneQueue.then(async () => {
          const latest = await readCloneJob();
          if (latest?.id === job.id && latest.phase === 'watching') await saveCloneJob({ ...latest,
            phase: 'error', message: '监控页面关闭、退出登录或克隆参数改变，已停止' });
        });
      }
      return;
    }
    const instances = await snapshotInstances();
    const matches = instances.filter(instance => !job.baseline.includes(instance.id) &&
      instance.region === job.context.regionName && instance.host === job.selected.name &&
      CloneCore.normalize(instance.spec).startsWith(`${job.selected.model} * ${job.config.count}卡`));
    cloneQueue = cloneQueue.then(async () => {
      const latest = await readCloneJob();
      if (latest?.id !== job.id || !['submitting', 'submitted'].includes(latest.phase)) return;
      if (matches.length === 1) {
        const instance = matches[0];
        if (instance.status.includes('运行中') && !instance.status.includes('无卡')) {
          await saveCloneJob({ ...latest, phase: 'success', newInstanceId: instance.id,
            message: `克隆实例 ${instance.id} 已带 GPU 运行，监控结束` });
          await cloneNotice('AutoDL 克隆开机成功', `${instance.host}，新实例 ${instance.id}`);
          await sendEmailNotification({ instanceName: `${instance.host} / ${instance.id}`, spec: instance.spec });
        } else if (/失败|异常/.test(instance.status)) {
          await saveCloneJob({ ...latest, phase: 'uncertain', message: `新实例 ${instance.id} 状态：${instance.status}，请检查；不会重复创建` });
        } else await saveCloneJob({ ...latest, phase: 'submitted', newInstanceId: instance.id,
          message: `新实例 ${instance.id}：${instance.status}；等待 GPU 运行` });
      } else if (Date.now() - latest.submittedAt > 20 * 60 * 1000 || matches.length > 1) {
        await saveCloneJob({ ...latest, phase: 'uncertain', message: '未能唯一确认新实例；请检查控制台后解除锁定，不会自动重试' });
        await cloneNotice('AutoDL 克隆结果需要核实', '请查看控制台，提交已锁定，不会重复创建');
      }
    });
    await cloneQueue;
  } catch (error) { console.error('克隆状态核实失败，将继续只读核实：', error.message); }
  finally { cloneTracking = false; }
});
