(() => {
  const $ = id => document.getElementById(id);
  let cloneTabId;
  const message = (action, data = {}) => chrome.runtime.sendMessage({ action, ...data });
  function show(value) { $('cloneStatus').textContent = value; }
  async function loadContext() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab?.url?.startsWith('https://www.autodl.com/cloneInstance?')) {
      throw new Error('请先在源实例“更多 → 克隆实例”勾选数据盘并继续，然后在克隆页面打开插件');
    }
    const response = await chrome.tabs.sendMessage(tab.id, { action: 'cloneContext' });
    if (!response?.success) throw new Error(response?.error || '请刷新克隆页面以加载新版插件');
    cloneTabId = tab.id;
    $('cloneSource').textContent = `${response.context.sourceId} · ${response.context.regionName} · 复制系统盘及数据盘`;
    const saved = (await chrome.storage.local.get('cloneSettings')).cloneSettings || {};
    $('cloneModels').replaceChildren(...response.context.models.map(model => {
      const option = document.createElement('option');
      option.value = model; option.textContent = model; option.selected = (saved.models || []).includes(model);
      return option;
    }));
    if (saved.count) $('cloneCount').value = saved.count;
    if (saved.maxPrice) $('cloneMaxPrice').value = saved.maxPrice;
    if (saved.interval) $('cloneInterval').value = saved.interval;
    // Preview is always on when the popup first opens; live submission needs an explicit user choice.
    show('源实例和地区读取成功；请设置筛选条件');
  }
  async function status() {
    const response = await message('cloneStatus');
    const job = response?.job;
    const active = job && ['watching', 'submitting', 'submitted'].includes(job.phase);
    $('cloneStart').disabled = !!active;
    $('cloneStop').disabled = !active;
    $('cloneUnlock').hidden = !job || !['submitted', 'uncertain'].includes(job.phase);
    if (job) {
      show(job.message);
      $('cloneSource').textContent = `${job.context.sourceId} · ${job.context.regionName} · 复制数据盘`;
    }
  }
  $('cloneRead').addEventListener('click', () => loadContext().catch(error => show(error.message)));
  $('cloneStart').addEventListener('click', async () => {
    $('cloneStart').disabled = true;
    try {
      if (!cloneTabId) throw new Error('请先点击“读取当前克隆页”');
      const cfg = CloneCore.options({ models: Array.from($('cloneModels').selectedOptions).map(e => e.value),
        count: $('cloneCount').value, maxPrice: $('cloneMaxPrice').value,
        interval: $('cloneInterval').value, preview: $('clonePreview').checked });
      // Reuse the existing notification UI without introducing a second set of credentials.
      await persistNotifySettingsFromUI();
      await chrome.storage.local.set({ cloneSettings: cfg });
      const response = await message('cloneStart', { tabId: cloneTabId, config: cfg });
      if (!response?.success) throw new Error(response?.error || '启动失败');
      await status();
    } catch (error) { show(error.message); $('cloneStart').disabled = false; }
  });
  $('cloneStop').addEventListener('click', async () => { await message('cloneStop'); await status(); });
  $('cloneUnlock').addEventListener('click', async () => {
    if (!confirm('请先在 AutoDL 控制台核实是否已创建实例。确认已核实，解除提交锁定？')) return;
    await message('cloneUnlock'); await status();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.cloneMonitorJob) status();
  });
  status();
})();
