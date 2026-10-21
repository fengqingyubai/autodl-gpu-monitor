/* DOM adapter verified against AutoDL's ordinary-instance clone page. */
(() => {
  'use strict';
  if (window.__autodlCloneAdapter) return;
  window.__autodlCloneAdapter = true;
  const C = CloneCore;
  let busy = false;
  let reloadTimer;
  let retryDelay = 0;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = e => !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const text = e => C.normalize(e?.innerText || e?.textContent);
  const rpc = (action, data = {}) => chrome.runtime.sendMessage({ action, adapterVersion: C.VERSION, ...data });
  const inputs = (root, type) => Array.from(root.querySelectorAll(`input[type="${type}"]`));
  function filter(label) {
    const item = Array.from(document.querySelectorAll('.filter-item')).find(e =>
      text(e.querySelector('.filter-label')).replace(/[:：]/g, '') === label);
    if (!item) throw new Error(`找不到“${label}”控件，页面可能已更新`);
    return item;
  }
  function pageContext() {
    const ctx = C.context(location.href);
    if (!text(document.body).includes('克隆实例仅能在同一地区内进行') ||
        !text(document.body).includes(`以实例：${ctx.sourceId}的系统创建新实例`)) {
      throw new Error('无法核实当前页面的源实例和同地区克隆限制');
    }
    const regionItem = filter('选择地区');
    const regions = inputs(regionItem, 'radio');
    const enabled = regions.filter(e => !e.disabled);
    // In the live page, only the source data centre is enabled. Other region groups may be siblings.
    const selected = enabled.filter(e => e.checked);
    if (enabled.length !== 1 || selected.length !== 1) throw new Error('地区未锁定到唯一的源实例地区');
    const models = inputs(filter('GPU型号'), 'checkbox').map(e => e.value).filter(v => !['false', 'CPU'].includes(v));
    if (!models.length) throw new Error('GPU 型号尚未加载，请等待页面加载完成');
    return { ...ctx, adapterVersion: C.VERSION, dataCenter: selected[0].value, regionName: text(selected[0].closest('label')), models };
  }
  function machines() {
    return Array.from(document.querySelectorAll('.el-table__body tr')).flatMap(row => {
      const cells = Array.from(row.querySelectorAll('td'));
      const radio = row.querySelector('input[type="radio"]');
      if (cells.length !== 9 || !radio) return [];
      const free = text(cells[3]).match(/^(\d+)\s*\/\s*(\d+)$/);
      const modelNode = cells[2].querySelector('.cell > div');
      const model = C.normalize((modelNode?.innerHTML || '').split(/<br\s*\/?\s*>/i)[0].replace(/<[^>]+>/g, ''));
      // Ignore struck-through original prices; the first live price span is the payable card price.
      const priceNode = cells[8].querySelector('.price > span:not([style*="line-through"])');
      return [{ id: radio.value, name: text(cells[1]), model,
        available: free ? Number(free[1]) : -1, price: C.money(text(priceNode)),
        enabled: !radio.disabled, row, radio }];
    });
  }
  async function current(job) {
    const response = await rpc('cloneJob');
    if (!response?.job || response.job.id !== job.id || response.job.phase !== 'watching') {
      throw new Error('监控已停止或任务已变更');
    }
    const ctx = pageContext();
    C.assertContext(ctx, job.context);
    if (ctx.dataCenter !== job.context.dataCenter) throw new Error('源地区发生变化');
    return ctx;
  }
  async function clickInput(input, job) {
    await current(job);
    if (!input || input.disabled) throw new Error('筛选控件不可用');
    input.closest('label').click();
    await sleep(200);
  }
  function loading() {
    return Array.from(document.querySelectorAll('.el-loading-mask')).some(visible);
  }
  async function settle(job) {
    let previous = '';
    let stable = 0;
    for (let i = 0; i < 60; i++) {
      await current(job);
      const fingerprint = machines().map(m => `${m.id}:${m.available}:${m.price}`).join('|');
      stable = fingerprint === previous && !loading() ? stable + 1 : 0;
      previous = fingerprint;
      if (stable >= 2) return;
      await sleep(200);
    }
    throw new Error('主机列表加载超时，请检查网络后重新开始');
  }
  async function applyFilters(job) {
    const cfg = job.config;
    const typeInputs = inputs(filter('GPU型号'), 'checkbox').filter(e => e.value !== 'false');
    for (const model of cfg.models) {
      if (!typeInputs.some(e => e.value === model)) throw new Error(`本地区没有型号：${model}`);
    }
    for (const input of typeInputs) {
      if (input.checked !== cfg.models.includes(input.value)) await clickInput(input, job);
    }
    // Trigger AutoDL's native query even when all filters already match. No full document reload.
    const refreshInput = typeInputs.find(input => cfg.models.includes(input.value));
    if (!refreshInput?.checked) throw new Error('GPU 筛选未就绪');
    await clickInput(refreshInput, job);
    await settle(job);
    const refreshedInput = inputs(filter('GPU型号'), 'checkbox').find(input => input.value === refreshInput.value);
    await clickInput(refreshedInput, job);
    const count = inputs(filter('GPU数量'), 'radio').find(e => e.value === String(cfg.count));
    if (!count) throw new Error('页面不支持该 GPU 数量');
    if (!count.checked) await clickInput(count, job);
    const payg = document.querySelector('input[type="radio"][value="payg"]');
    if (!payg) throw new Error('无法确认按量计费');
    if (!payg.checked) await clickInput(payg, job);
    await settle(job);
    const table = Array.from(document.querySelectorAll('.el-table')).find(e => text(e).includes('空闲GPU'));
    const head = Array.from(table?.querySelectorAll('th') || []).find(e => text(e).startsWith('空闲GPU'));
    const descending = head?.querySelector('.sort-caret.descending');
    if (!descending) throw new Error('找不到库存排序控件');
    if (!head.classList.contains('descending')) {
      await current(job);
      descending.click();
      await settle(job);
    }
    if (!head.classList.contains('descending')) throw new Error('未能确认空闲 GPU 降序排列');
    return table;
  }
  async function candidate(job, table) {
    const scroller = table.querySelector('.el-table__body-wrapper');
    let previous = '';
    // AutoDL lazy-loads rows. Search beyond the first ten rows when all early rows are over budget.
    for (let i = 0; i < 200; i++) {
      await current(job);
      const rows = machines();
      const matches = rows.filter(m => C.eligible(m, job.config)).sort((a, b) => a.price - b.price);
      if (matches.length) return matches[0];
      if (rows.length && rows.some(m => m.available >= 0 && m.available < job.config.count)) return null;
      const fingerprint = rows.map(m => m.id).join('|');
      if (!scroller || (i > 0 && fingerprint === previous)) return null;
      previous = fingerprint;
      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await sleep(800);
      await settle(job);
    }
    throw new Error('主机列表超过扫描上限，请缩小 GPU 型号范围');
  }
  async function selectMachine(job, machine) {
    await current(job);
    machine.row.click();
    await settle(job);
    const checked = machines().filter(m => m.radio.checked);
    const fresh = checked.find(m => m.id === machine.id);
    if (checked.length !== 1 || !fresh || !C.eligible(fresh, job.config)) {
      const error = new Error('候选主机库存已变化，继续等待'); error.stockChanged = true; throw error;
    }
    const count = inputs(filter('GPU数量'), 'radio').find(e => e.checked)?.value;
    if (Number(count) !== job.config.count) throw new Error('GPU 数量发生变化');
    if (!document.querySelector('input[type="radio"][value="payg"]')?.checked) throw new Error('计费模式发生变化');
    const quoted = C.hourlyQuote(document);
    if (quoted > job.config.maxPrice || Math.abs(quoted - fresh.price * job.config.count) > 0.011) {
      throw new Error(`报价核对失败：配置费用 ￥${quoted.toFixed(2)}/小时；单卡 ￥${fresh.price.toFixed(2)} × ${job.config.count}；上限 ￥${job.config.maxPrice.toFixed(2)}/小时`);
    }
    // Paid disk expansion is not included in an hourly GPU cap. Do not silently add daily charges.
    const diskInputs = Array.from(document.querySelectorAll('.el-input-number input'));
    if (diskInputs.some(e => !Number.isFinite(Number(e.value)) || Number(e.value) !== 0) ||
        Number(new URL(location.href).searchParams.get('expand_size') || 0) !== 0) {
      throw new Error('检测到付费数据盘扩容，请先处理容量和费用后再监控');
    }
    return { id: fresh.id, name: fresh.name, model: fresh.model, price: fresh.price, total: quoted };
  }
  async function run() {
    if (busy || location.pathname !== '/cloneInstance') return;
    busy = true;
    let job, attemptId, clicked = false;
    try {
      const response = await rpc('cloneJob');
      job = response?.job;
      if (!job || job.phase !== 'watching') return;
      if (job.config.preview === true) throw new Error('旧版预览任务已停止，请在新版界面重新开始监控');
      await current(job);
      await rpc('cloneProgress', { id: job.id, message: '正在刷新库存…', stage: 'scanning' });
      const table = await applyFilters(job);
      const found = await candidate(job, table);
      await rpc('cloneRoundComplete', { id: job.id, roundId: crypto.randomUUID() });
      retryDelay = 0;
      if (!found) {
        await schedule(job, '等待符合条件的库存');
        return;
      }
      await rpc('cloneProgress', { id: job.id, message: `发现 ${found.name} ${found.model}，正在核对配置费用`, stage: 'checking' });
      const selected = await selectMachine(job, found);
      await current(job);
      const create = Array.from(document.querySelectorAll('button')).filter(visible)
        .filter(e => text(e) === '创建并开机');
      if (create.length !== 1 || create[0].disabled) throw new Error('创建并开机按钮不可用');
      // A durable one-shot barrier is persisted by the background before any billable click.
      const permit = await rpc('cloneReserve', { id: job.id, selected });
      if (!permit?.success) throw new Error(permit?.error || '提交被取消');
      attemptId = permit.attemptId;
      // Recheck the entire selection after awaiting the worker; no automatic confirmation of other dialogs.
      C.assertContext(pageContext(), job.context);
      const fresh = machines().find(m => m.id === selected.id && m.radio.checked);
      if (!fresh || !C.eligible(fresh, job.config) || C.hourlyQuote(document) !== selected.total) {
        const error = new Error('提交前库存或报价变化，继续监控'); error.stockChanged = true; throw error;
      }
      const allowed = await rpc('clonePermit', { id: job.id, attemptId });
      if (!allowed?.success) throw new Error('提交已取消');
      observeSubmission(job, attemptId);
      clicked = true;
      create[0].click();
      await rpc('cloneClicked', { id: job.id, attemptId });
      // The next page may show a required confirmation; leave it for the user. Never repeat the click.
    } catch (error) {
      if (!job) return;
      if (error.stockChanged && !clicked) {
        const released = !attemptId || (await rpc('cloneAbortBeforeClick', { id: job.id, attemptId })).success;
        if (released) { await schedule(job, error.message); return; }
      }
      if (!attemptId && /列表加载超时/.test(error.message)) {
        retryDelay = Math.min(30000, Math.max(job.config.interval * 1000, retryDelay * 2 || 3000));
        await schedule(job, '库存加载较慢，稍后重试', retryDelay); return;
      }
      await rpc('cloneError', { id: job.id, message: error.message }).catch(() => {});
    } finally { busy = false; }
  }
  async function schedule(job, message, delay = job.config.interval * 1000) {
    await current(job);
    await rpc('cloneProgress', { id: job.id, message, stage: 'waiting', nextCheckAt: Date.now() + delay });
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => run(), delay);
  }
  function observeSubmission(job, attemptId) {
    const selector = '.el-message--error, .el-notification--error';
    const seen = new Set(Array.from(document.querySelectorAll(selector)).map(text));
    const observer = new MutationObserver(() => {
      for (const node of document.querySelectorAll(selector)) {
        const notice = text(node).slice(0, 1000);
        if (!visible(node) || !notice || seen.has(notice)) continue;
        seen.add(notice);
        rpc('cloneSubmissionNotice', { id: job.id, attemptId, notice }).catch(() => {});
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    setTimeout(() => observer.disconnect(), 15000);
  }
  chrome.runtime.onMessage.addListener((request, sender, respond) => {
    if (request.action === 'cloneContext') {
      try { respond({ success: true, context: pageContext() }); }
      catch (error) { respond({ success: false, error: error.message }); }
    } else if (request.action === 'cloneRun') {
      clearTimeout(reloadTimer);
      respond({ success: true });
      run();
    } else if (request.action === 'cloneListSnapshot') {
      listSnapshot().then(result => respond({ success: true, instances: result }))
        .catch(error => respond({ success: false, error: error.message }));
      return true;
    }
    return false;
  });
  async function listSnapshot() {
    if (location.pathname !== '/console/instance/list') throw new Error('不是实例列表页面');
    const result = new Map();
    for (let page = 0; page < 200; page++) {
      let rows;
      for (let attempt = 0; attempt < 40; attempt++) {
        rows = Array.from(document.querySelectorAll('.el-table__body tr'));
        if (rows.length && !loading()) break;
        await sleep(300);
      }
      if (!rows?.length) throw new Error('实例列表未加载或登录已过期');
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td'));
        const id = text(cells[0]).match(/\b[\w]+-[\w]+\b/)?.[0];
        if (!id) throw new Error('无法读取实例 ID');
        const regionHost = text(cells[0]).match(/^(.+?区)\s*\/\s*(\d+机)/);
        result.set(id, { id, region: regionHost?.[1], host: regionHost?.[2],
          spec: text(cells[2]), status: text(cells[1]) });
      }
      const next = document.querySelector('.el-pagination .btn-next');
      if (!next || next.disabled || next.getAttribute('aria-disabled') === 'true') return [...result.values()];
      const first = text(rows[0]);
      next.click();
      let changed = false;
      for (let i = 0; i < 40; i++) {
        await sleep(300);
        if (!loading() && text(document.querySelector('.el-table__body tr')) !== first) { changed = true; break; }
      }
      if (!changed) throw new Error('实例列表翻页超时');
    }
    throw new Error('实例列表超过扫描上限');
  }
  // Vue may mount after document_idle. Retry readiness without interacting with the page.
  let attempts = 0;
  const ready = setInterval(() => {
    if (location.pathname !== '/cloneInstance' || ++attempts > 60) { clearInterval(ready); return; }
    try { pageContext(); clearInterval(ready); run(); } catch (_) { /* wait for DOM */ }
  }, 500);
})();
