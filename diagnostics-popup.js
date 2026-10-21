(() => {
  const $ = id => document.getElementById(id);
  const status = $('diagnosticStatus');
  async function read() {
    const result = await chrome.runtime.sendMessage({ action: 'diagnosticRead' });
    if (!result?.success || !result.log) throw new Error(result?.error || '请在扩展管理页重新加载新版插件');
    status.textContent = `${result.log.entries.length} 条 · ${(result.log.bytes / 1024).toFixed(1)} / 512 KiB` +
      (result.log.dropped ? ` · 已淘汰 ${result.log.dropped} 条旧记录` : '');
    return result;
  }
  $('diagnosticExport').addEventListener('click', async () => {
    try {
      const text = encodeDiagnosticExport(await read());
      const url = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url; link.download = `autodl-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (error) { status.textContent = error.message; }
  });
  $('diagnosticClear').addEventListener('click', async () => {
    try { await chrome.runtime.sendMessage({ action: 'diagnosticClear' }); await read(); }
    catch (error) { status.textContent = error.message; }
  });
  $('diagnosticExport').closest('details').addEventListener('toggle', async event => {
    if (event.currentTarget.open) await read().catch(error => { status.textContent = error.message; });
  });
  chrome.runtime.sendMessage({ action: 'diagnosticPopup', popupVersion: CloneCore.VERSION }).then(read)
    .catch(error => { status.textContent = error.message; });
})();
