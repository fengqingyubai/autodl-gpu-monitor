(() => {
  const tabs = Array.from(document.querySelectorAll('[data-panel]'));
  function select(name) {
    if (!['clone', 'legacy', 'notifications'].includes(name)) name = 'clone';
    for (const tab of tabs) {
      const active = tab.dataset.panel === name;
      tab.setAttribute('aria-selected', String(active));
      document.getElementById(`${tab.dataset.panel}Panel`).hidden = !active;
    }
    chrome.storage.local.set({ popupPanel: name });
  }
  for (const tab of tabs) tab.addEventListener('click', () => select(tab.dataset.panel));
  chrome.storage.local.get('popupPanel').then(saved => select(saved.popupPanel || 'clone'));
})();
