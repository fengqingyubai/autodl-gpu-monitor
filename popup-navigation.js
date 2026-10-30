(() => {
  const tabs = Array.from(document.querySelectorAll('[data-panel]'));
  function select(name) {
    if (!['clone', 'rent', 'legacy', 'notifications'].includes(name)) name = 'clone';
    for (const tab of tabs) {
      const active = tab.dataset.panel === name;
      tab.setAttribute('aria-selected', String(active));
    }
    for (const panel of ['clone', 'legacy', 'notifications']) {
      document.getElementById(`${panel}Panel`).hidden = panel === 'clone' ? !['clone', 'rent'].includes(name) : name !== panel;
    }
    if (['clone', 'rent'].includes(name)) document.dispatchEvent(new CustomEvent('creation-mode-change', { detail: name }));
    chrome.storage.local.set({ popupPanel: name });
  }
  for (const tab of tabs) tab.addEventListener('click', () => select(tab.dataset.panel));
  chrome.storage.local.get('popupPanel').then(saved => select(saved.popupPanel || 'clone'));
})();
