(() => {
  const $ = id => document.getElementById(id);
  const message = (action, data = {}) => chrome.runtime.sendMessage({ action, ...data });
  let cloneTabId, lastJob, starting = false, mode = 'clone', modeInitialized = false;
  const settingsKey = () => mode === 'rent' ? 'rentSettings' : 'cloneSettings';
  const describe = ctx => `${ctx.regionName} · ${ctx.mode === 'rent' ? ctx.imageSelection : ctx.sourceId}` +
    (ctx.imageCuda ? ` · 镜像 CUDA ${ctx.imageCuda}` : '');
  function readError(error) {
    show(error.message, 'page-error');
    $('cloneRunDetails').textContent = '';
    $('cloneCountdown').textContent = '';
  }
  const edited = new Set();
  for (const id of ['cloneModels', 'cloneCount', 'cloneMaxPrice', 'cloneInterval']) {
    for (const event of ['input', 'change']) $(id).addEventListener(event, () => edited.add(id));
  }
  function show(value, phase = 'idle') {
    $('cloneState').hidden = false;
    $('cloneStatus').textContent = value;
    $('cloneState').dataset.state = phase;
    $('cloneStateTitle').textContent = ({ watching: '监控进行中', submitting: '正在创建实例',
      submitted: '正在核实创建结果', success: '实例开机成功', error: '监控已停止 · 出错', 'page-error': '页面读取失败', 'start-error': '启动失败',
      uncertain: '需要核实', stopped: '已停止', starting: '正在启动…' }[phase] || '提示');
  }
  function setBusy(active) {
    for (const tab of document.querySelectorAll('[data-panel="clone"], [data-panel="rent"]')) tab.disabled = starting;
    for (const id of ['cloneRead', 'cloneModels', 'cloneCount', 'cloneMaxPrice', 'cloneInterval']) $(id).disabled = active;
    $('cloneStart').disabled = active;
    $('cloneStart').textContent = starting ? '正在启动…' : active ? '监控已开启' : '开始监控并自动创建';
    $('cloneStop').disabled = !active || starting;
  }
  async function loadContext() {
    const readingMode = mode;
    cloneTabId = undefined;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (readingMode !== mode) return;
    if (!tab?.url) throw new Error('请先打开 AutoDL 创建页面');
    if (mode === 'rent') CloneCore.rentalContext(tab.url);
    else CloneCore.context(tab.url);
    let response;
    try { response = await chrome.tabs.sendMessage(tab.id, { action: 'cloneContext' }); }
    catch (_) { throw new Error('无法连接页面脚本，请刷新当前 AutoDL 页面后重新读取'); }
    if (!response?.success) throw new Error(response?.error || '请刷新 AutoDL 创建页面以加载新版插件');
    if (readingMode !== mode) return;
    if ((response.context.mode || 'clone') !== mode) throw new Error('当前页面与所选模式不符');
    if (response.context.adapterVersion !== CloneCore.VERSION) throw new Error('请刷新 AutoDL 创建页面，以加载新版网页脚本');
    cloneTabId = tab.id;
    $('cloneSource').textContent = describe(response.context);
    const key = settingsKey();
    const saved = (await chrome.storage.local.get(key))[key] || {};
    if (readingMode !== mode) return;
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
      if (active) {
        $('cloneStateTitle').textContent = `${job.context.mode === 'rent' ? '新租' : '克隆'} · ${$('cloneStateTitle').textContent}`;
        $('cloneSource').textContent = describe(job.context);
      }
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
    .then(() => { if (!lastJob || !['watching', 'submitting', 'submitted', 'uncertain'].includes(lastJob.phase)) $('cloneState').hidden = true; })
    .catch(readError));
  $('cloneStart').addEventListener('click', async () => {
    try {
      for (const id of ['cloneMaxPrice', 'cloneInterval']) {
        if (!$(id).reportValidity()) return;
      }
      if (!cloneTabId) throw new Error('请先读取当前创建页面，再设置监控条件');
      const cfg = CloneCore.options({ models: Array.from($('cloneModels').selectedOptions).map(e => e.value),
        count: $('cloneCount').value, maxPrice: $('cloneMaxPrice').value, interval: $('cloneInterval').value });
      starting = true;
      show(mode === 'rent' ? '正在核实地区、镜像与已有实例…' : '正在核实源实例与地区…', 'starting');
      $('cloneRunDetails').textContent = '';
      $('cloneCountdown').textContent = '';
      window.scrollTo({ top: 0, behavior: 'instant' });
      setBusy(true);
      await persistNotifySettingsFromUI();
      await chrome.storage.local.set({ [settingsKey()]: cfg });
      const response = await message('cloneStart', { tabId: cloneTabId, mode, config: cfg, popupVersion: CloneCore.VERSION });
      if (!response?.success) throw new Error(response?.error || '启动失败');
      starting = false;
      await status();
    } catch (error) {
      starting = false; setBusy(false); show(error.message, 'start-error');
      $('cloneRunDetails').textContent = ''; $('cloneCountdown').textContent = '';
      window.scrollTo({ top: 0, behavior: 'instant' });
    }
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
  document.addEventListener('creation-mode-change', async event => {
    if (starting) return;
    if (modeInitialized && mode === event.detail) return;
    modeInitialized = true;
    mode = event.detail;
    cloneTabId = undefined;
    edited.clear();
    $('cloneModels').replaceChildren();
    $('cloneSource').textContent = mode === 'rent' ? '未读取地区与镜像' : '未读取源实例';
    $('cloneMaxPrice').value = '';
    $('cloneCount').value = '1';
    $('cloneInterval').value = '3';
    $('creationInstructions').textContent = mode === 'rent' ?
      '在 AutoDL 点击“租用新实例”，只选择一个地区，选好基础镜像的完整版本，再读取当前页面。无需已有实例。' :
      '先在已关机源实例的“更多 → 克隆实例”勾选数据盘，点击继续。在克隆页打开插件。';
    $('cloneRead').textContent = mode === 'rent' ? '读取当前新租页' : '读取当前克隆页';
    $('creationDiskNote').textContent = mode === 'rent' ? '仅按量计费；使用网页选定的基础镜像；不复制已有数据，不增加付费数据盘容量。' :
      '仅按量计费；强制复制系统盘和数据盘；不自动增加付费数据盘容量。';
    await status().catch(readError);
    await loadContext().catch(() => {});
  });
  status().catch(readError);
})();
