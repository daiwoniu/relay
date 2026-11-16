(function offlineShare() {
  const d = document;
  const all = (selector, root = d) => [...root.querySelectorAll(selector)];
  const one = (selector, root = d) => root.querySelector(selector);
  const setExpanded = (button, expanded) => {
    const panel = d.getElementById(button.dataset.staticShareTarget);
    if (!panel) return;
    button.setAttribute('aria-expanded', String(expanded));
    const user = button.closest('.user-message');
    const icon = one('.changed-files-summary__chevron', button) || one('svg', button);
    if (user) {
      panel.classList.toggle('user-message-collapsed', !expanded);
      const fade = one('.user-message-fade', user);
      if (fade) fade.hidden = expanded;
      button.firstChild.data = expanded ? '\u6536\u8d77' : '\u663e\u793a\u66f4\u591a';
      if (icon) icon.classList.toggle('rotate-180', expanded);
    } else {
      panel.hidden = !expanded;
      if (icon) { icon.classList.toggle('-rotate-90', !expanded); icon.classList.toggle('is-expanded', expanded); }
    }
  };
  all('button[data-static-share-target]').forEach(button => setExpanded(button, false));
  d.addEventListener('click', event => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const button = target.closest('button[data-static-share-target]');
    if (button) { setExpanded(button, button.getAttribute('aria-expanded') !== 'true'); return; }
    const wide = target.closest('[data-static-share-wide]');
    if (wide) {
      const expanded = wide.getAttribute('aria-pressed') !== 'true';
      wide.setAttribute('aria-pressed', String(expanded));
      wide.setAttribute('aria-label', expanded ? '\u6062\u590d\u6807\u51c6\u5bbd\u5ea6' : '\u5207\u6362\u5bbd\u5c4f\u663e\u793a');
      [one('header>div'), ...all('main>div')].filter(Boolean).forEach((element, index) => {
        element.classList.toggle(index ? 'max-w-3xl' : 'max-w-4xl', !expanded);
        element.classList.toggle('max-w-none', expanded);
      });
      const path = one('path', wide);
      if (path) path.setAttribute('d', expanded ? 'M3 5l3 3-3 3m10-6-3 3 3 3' : 'M6 5 3 8l3 3m4-6 3 3-3 3');
      return;
    }
    const theme = target.closest('[data-static-share-theme]');
    if (theme) {
      const name = d.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      d.documentElement.dataset.theme = name;
      theme.setAttribute('aria-label', '\u5207\u6362\u4e3b\u9898\uff08\u5f53\u524d\uff1a' + (name === 'dark' ? '\u6697\u8272' : '\u6d45\u8272') + '\uff09');
      const path = one('[data-static-share-theme-icon]', theme);
      if (path) path.setAttribute('d', name === 'dark' ? 'M10.8 10.9A5 5 0 015.1 5.2 5.5 5.5 0 1010.8 10.9z' : 'M8 2.2v1.4M8 12.4v1.4M2.2 8h1.4M12.4 8h1.4M3.9 3.9l1 1M11.1 11.1l1 1M12.1 3.9l-1 1M4.9 11.1l-1 1M10.5 8A2.5 2.5 0 115.5 8a2.5 2.5 0 015 0z');
    }
  });
})();
