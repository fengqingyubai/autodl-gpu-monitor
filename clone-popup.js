(() => {
  const $ = id => document.getElementById(id);
  const message = (action, data = {}) => chrome.runtime.sendMessage({ action, ...data });
  let cloneTabId, lastJob, starting = false;
  const edited = new Set();
  for (const id of ['cloneModels', 'cloneCount', 'cloneMaxPrice', 'cloneInterval']) {
    for (const event of ['input', 'change']) $(id).addEventListener(event, () => edited.add(id));
  }
  function show(value, phase = 'idle') {
    $('cloneState').hidden = false;
    $('cloneStatus').textContent = value;
    $('cloneState').dataset.state = phase;
    $('cloneStateTitle').textContent = ({ watching: '监控进行中', submitting: '正在创建实例',
      submitted: '正在等待开机', success: '克隆开机成功', error: '监控已停止 · 出错',
      uncertain: '需要核实', stopped: '已停止', starting: '正在启动…' }[phase] || '提示');
  }
  function setBusy(active) {
    for (const id of ['cloneRead', 'cloneModels', 'cloneCount', 'cloneMaxPrice', 'cloneInterval']) $(id).disabled = active;
    $('cloneStart').disabled = active;
    $('cloneStart').textContent = starting ? '正在启动…' : active ? '监控已开启' : '开始监控并自动创建';
    $('cloneStop').disabled = !active || starting;
  }
  async function loadContext() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.startsWith('https://www.autodl.com/cloneInstance?')) {
      throw new Error('请从已关机源实例进入克隆页，并勾选复制数据盘');
    }
    const response = await chrome.tabs.sendMessage(tab.id, { action: 'cloneContext' });
    if (!response?.success) throw new Error(response?.error || '请刷新克隆页面以加载新版插件');
    if (response.context.adapterVersion !== CloneCore.VERSION) throw new Error('请刷新 AutoDL 克隆页面，以加载新版网页脚本');
    cloneTabId = tab.id;
    $('cloneSource').textContent = `${response.context.regionName} · ${response.context.sourceId}`;
    const saved = (await chrome.storage.local.get('cloneSettings')).cloneSettings || {};
    const chosenModels = edited.has('cloneModels') ? Array.from($('cloneModels').selectedOptions).map(e => e.value) : saved.models || [];
    $('cloneModels').replaceChildren(...response.context.models.map(model => {
      const option = document.createElement('option');
      option.value = model; option.textContent = model; option.selected = chosenModels.includes(model);
      return option;
    }));
    if (saved.count && !edited.has('cloneCount')) $('cloneCount').value = saved.count;
    if (saved.maxPrice && !edited.has('cloneMaxPrice')) $('cloneMaxPrice').value = saved.maxPrice;
    if (saved.interval && !edited.has('cloneInterval')) $('cloneInterval').value = saved.interval;
  }
  function render(job) {
    if (lastJob?.id === job?.id && ((job?.updatedAt || 0) < (lastJob?.updatedAt || 0) ||
        (job?.updatedAt === lastJob?.updatedAt && (job?.round || 0) < (lastJob?.round || 0)))) return;
    lastJob = job;
    if (starting && (!job || !['watching', 'submitting', 'submitted'].includes(job.phase))) return;
    const active = job && ['watching', 'submitting', 'submitted'].includes(job.phase);
    setBusy(!!active);
    $('cloneUnlock').hidden = !job || !['submitted', 'uncertain'].includes(job.phase);
    if (job) {
      show(job.message, job.phase);
      if (active) $('cloneSource').textContent = `${job.context.regionName} · ${job.context.sourceId}`;
      $('cloneRunDetails').textContent = job.round > 0 ? `已检查 ${job.round} 轮` : '首次检查中';
    } else if (!starting) {
      $('cloneState').hidden = true;
    }
    countdown();
  }
  function countdown() {
    $('cloneCountdown').textContent = lastJob?.phase === 'watching' && lastJob.nextCheckAt ?
      `下次检查约 ${Math.max(0, Math.ceil((lastJob.nextCheckAt - Date.now()) / 1000))} 秒后` : '';
  }
  async function status() {
    const response = await message('cloneStatus');
    if (response?.success) render(response.job);
  }
  $('cloneRead').addEventListener('click', () => loadContext()
    .then(() => { if (!lastJob) $('cloneState').hidden = true; })
    .catch(error => show(error.message, 'error')));
  $('cloneStart').addEventListener('click', async () => {
    try {
      for (const id of ['cloneMaxPrice', 'cloneInterval']) {
        if (!$(id).reportValidity()) return;
      }
      if (!cloneTabId) throw new Error('请先读取当前克隆页，再设置监控条件');
      const cfg = CloneCore.options({ models: Array.from($('cloneModels').selectedOptions).map(e => e.value),
        count: $('cloneCount').value, maxPrice: $('cloneMaxPrice').value, interval: $('cloneInterval').value });
      starting = true;
      show('正在核实源实例与地区…', 'starting');
      window.scrollTo({ top: 0, behavior: 'instant' });
      setBusy(true);
      await persistNotifySettingsFromUI();
      await chrome.storage.local.set({ cloneSettings: cfg });
      const response = await message('cloneStart', { tabId: cloneTabId, config: cfg });
      if (!response?.success) throw new Error(response?.error || '启动失败');
      starting = false;
      await status();
    } catch (error) { starting = false; setBusy(false); show(error.message, 'error'); window.scrollTo({ top: 0, behavior: 'instant' }); }
  });
  $('cloneStop').addEventListener('click', async () => { await message('cloneStop'); await status(); });
  $('cloneUnlock').addEventListener('click', async () => {
    if (!confirm('请先在 AutoDL 控制台核实是否已创建实例。确认已核实，解除提交锁定？')) return;
    await message('cloneUnlock'); await status();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.cloneMonitorJob) render(changes.cloneMonitorJob.newValue);
  });
  setInterval(countdown, 1000);
  loadContext().catch(() => {}).finally(() => status().catch(error => show(error.message, 'error')));
})();
