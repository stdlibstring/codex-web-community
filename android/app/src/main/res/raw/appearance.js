(() => {
  if (window !== window.top) return;
  let previous;
  let queued = false;
  const publish = () => {
    queued = false;
    const workbench = document.querySelector('.monaco-workbench');
    let mode = document.documentElement?.dataset.theme;
    if (workbench) {
      if (workbench.classList.contains('vs-dark') || workbench.classList.contains('hc-black')) mode = 'dark';
      else if (workbench.classList.contains('vs') || workbench.classList.contains('hc-light')) mode = 'light';
      else return;
    }
    if ((mode === 'dark' || mode === 'light') && mode !== previous) {
      window.CodexAppearance.postMessage(mode);
      previous = mode;
    }
  };
  new MutationObserver(() => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(publish);
    }
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-theme'] });
  publish();
})();
