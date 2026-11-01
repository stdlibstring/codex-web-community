import { getAppearance, subscribeAppearance, toggleAppearance } from '/appearance.js';

export function installWebviewVisibility(OverlayWebview) {
  const overlay = OverlayWebview.prototype;
  const show = overlay._show;
  const release = overlay.release;
  const setAnchorElement = overlay.setAnchorElement;
  const retained = new Map();
  const viewTypes = new Set(['chatgpt.sidebarView', 'chatgpt.sidebarSecondaryView', 'claudeVSCodeSidebar', 'claudeVSCodeSidebarSecondary', 'QoderCN.Chat']);
  const supported = view => viewTypes.has(view.providedViewType)
    && ['openai.chatgpt', 'anthropic.claude-code', 'alibaba-cloud.tongyi-lingma'].includes(view.extension?.id.value.toLowerCase());
  const properties = ['position', 'position-anchor', 'top', 'left', 'width', 'height'];
  const rootProperties = [...properties, 'right', 'bottom', 'clip-path'];
  const visibilityStyle = document.createElement('style');
  visibilityStyle.textContent = '.webview-overlay-content.codex-web-retained { visibility: visible !important; }';
  document.head.append(visibilityStyle);
  const capture = entry => {
    if (entry.hidden) return;
    const anchor = entry.view._anchorState?.anchorElement;
    if (!anchor) return;
    const anchorRect = anchor.getBoundingClientRect();
    if (anchorRect.width <= 0 || anchorRect.height <= 0) return;
    const part = anchor.closest('.part');
    if (!part) return;
    const bounds = part.getBoundingClientRect();
    if (anchorRect.top < Math.max(0, bounds.top) || anchorRect.left < Math.max(0, bounds.left)
      || anchorRect.bottom > Math.min(innerHeight, bounds.bottom) + 1 || anchorRect.right > Math.min(innerWidth, bounds.right) + 1) return;
    entry.rect = anchorRect;
    entry.content.classList.add('codex-web-retained');
  };
  const restore = entry => {
    if (!entry.hidden) return;
    for (const property of rootProperties) entry.root.style.setProperty(property, entry.layout.root[property]);
    for (const property of properties) entry.content.style.setProperty(property, entry.layout.content[property]);
    entry.content.style.opacity = '';
    entry.content.style.pointerEvents = 'auto';
    entry.content.inert = false;
    entry.content.removeAttribute('aria-hidden');
    entry.hidden = false;
  };
  const track = view => {
    if (retained.has(view)) return retained.get(view);
    const content = view.container;
    const entry = { view, content, root: view.overlayLayout.root, hidden: false, rect: undefined, layout: undefined };
    const observer = new ResizeObserver(() => capture(entry));
    observer.observe(content);
    retained.set(view, entry);
    entry.subscription = view.onDidDispose(() => {
      observer.disconnect();
      content.classList.remove('codex-web-retained');
      retained.delete(view);
      entry.subscription.dispose();
    });
    entry.observer = observer;
    return entry;
  };
  overlay._show = function (...args) {
    if (!supported(this)) return show.apply(this, args);
    const entry = retained.get(this);
    if (entry) restore(entry);
    const result = show.apply(this, args);
    capture(track(this));
    return result;
  };
  overlay.setAnchorElement = function (...args) {
    const result = setAnchorElement.apply(this, args);
    const entry = retained.get(this);
    if (entry && this._owner) capture(entry);
    return result;
  };
  overlay.release = function (owner) {
    const entry = retained.get(this);
    if (!supported(this) || !this.options.retainContextWhenHidden || this._owner !== owner || !entry?.rect) return release.call(this, owner);
    // 标签隐藏后两个原生 anchor 都会失效，保存内容布局和外层裁剪布局。
    if (!entry.hidden) entry.layout = {
      content: Object.fromEntries(properties.map(property => [property, entry.content.style.getPropertyValue(property)])),
      root: Object.fromEntries(rootProperties.map(property => [property, entry.root.style.getPropertyValue(property)])),
    };
    entry.hidden = true;
    const result = release.call(this, owner);
    for (const [property, value] of Object.entries({ position: 'fixed', 'position-anchor': 'none', 'clip-path': 'none',
      top: `${entry.rect.top}px`, left: `${entry.rect.left}px`, width: `${entry.rect.width}px`, height: `${entry.rect.height}px`, right: 'auto', bottom: 'auto' })) {
      entry.root.style.setProperty(property, value);
    }
    for (const [property, value] of Object.entries({ position: 'absolute', 'position-anchor': 'none', top: '0', left: '0', width: '100%', height: '100%' })) {
      entry.content.style.setProperty(property, value);
    }
    entry.content.style.opacity = '0';
    entry.content.style.pointerEvents = 'none';
    entry.content.inert = true;
    entry.content.setAttribute('aria-hidden', 'true');
    return result;
  };
  return { dispose() {
    overlay._show = show;
    overlay.release = release;
    overlay.setAnchorElement = setAnchorElement;
    for (const entry of retained.values()) {
      const hidden = entry.hidden;
      restore(entry);
      entry.content.classList.remove('codex-web-retained');
      if (hidden) entry.content.style.visibility = 'hidden';
      entry.observer.disconnect();
      entry.subscription.dispose();
    }
    retained.clear();
    visibilityStyle.remove();
  } };
}

export function installWorkbenchAppearance(commands, themeServiceId, contextKeyServiceId, controls, registerContribution) {
  const webview = controls.webviewElement.prototype;
  const createElement = webview._createElement;
  const initializeElement = webview._initElement;
  const styleWebview = webview.style;
  // 使用固定的 Modern 主题中对应插件内容的背景颜色。
  const backgrounds = {
    'openai.chatgpt': { dark: '#1f1f1f', light: '#ffffff' },
    'anthropic.claude-code': { dark: '#181818', light: '#f8f8f8' },
    'alibaba-cloud.tongyi-lingma': { dark: '#181818', light: '#f8f8f8' },
  };
  const elements = new Map();
  let resolveThemeReady;
  const themeReady = new Promise(resolve => { resolveThemeReady = resolve; });
  const palette = view => backgrounds[view.extension?.id.value.toLowerCase()];
  const applyWebviewBackground = (view, element) => {
    const colors = palette(view);
    if (!colors) return;
    const { theme } = getAppearance();
    element.style.backgroundColor = colors[theme];
    element.style.colorScheme = theme;
  };
  webview._createElement = function (...args) {
    const element = createElement.apply(this, args);
    applyWebviewBackground(this, element);
    if (palette(this)) {
      elements.set(element, this);
      this._register({ dispose: () => elements.delete(element) });
    }
    return element;
  };
  webview._initElement = function (...args) {
    if (!palette(this)) return initializeElement.apply(this, args);
    return themeReady.then(() => {
      if (this._disposed) return;
      this.style();
      return initializeElement.apply(this, args);
    });
  };
  webview.style = function () {
    if (this.element) applyWebviewBackground(this, this.element);
    return styleWebview.call(this);
  };
  const unsubscribeBackground = subscribeAppearance(() => {
    for (const [element, view] of elements) applyWebviewBackground(view, element);
  });
  let runtime;
  const initialize = (service, keys, extensions) => {
    if (runtime) return runtime;
    const dark = keys.createKey('codexWeb.darkTheme', getAppearance().theme === 'dark');
    runtime = { service, desired: undefined, pending: undefined };
    runtime.ready = extensions.whenInstalledExtensionsRegistered().then(() => service.getColorThemes()).then(available => {
      const themes = new Map();
      for (const name of ['Dark Modern', 'Light Modern']) {
        const theme = available.find(entry => entry.settingsId === name);
        if (!theme) throw new Error(`没有找到主题 ${name}。`);
        themes.set(name, theme);
      }
      return themes;
    });
    const apply = () => {
      runtime.desired = getAppearance().theme;
      dark.set(runtime.desired === 'dark');
      if (runtime.pending) return runtime.pending;
      document.documentElement.dataset.codexThemeState = 'changing';
      runtime.pending = (async () => {
        const themes = await runtime.ready;
        const currentTheme = () => ['dark', 'hcDark'].includes(service.getColorTheme().type) ? 'dark' : 'light';
        while (currentTheme() !== runtime.desired) {
          const desired = runtime.desired;
          await service.setColorTheme(themes.get(desired === 'dark' ? 'Dark Modern' : 'Light Modern').id, 8);
          if (desired === runtime.desired && currentTheme() !== desired) throw new Error('工作台未能应用请求的明暗主题。');
        }
      })().then(() => {
        document.documentElement.dataset.codexThemeState = 'idle';
      }).finally(() => {
        runtime.pending = undefined;
      });
      return runtime.pending;
    };
    runtime.unsubscribe = subscribeAppearance(apply);
    runtime.subscription = service.onDidColorThemeChange(() => {
      if (!runtime.pending) void apply();
    });
    runtime.initial = apply().then(() => { resolveThemeReady(); });
    return runtime;
  };
  const registrations = [
    commands.registerCommand('codexWeb.initializeTheme', accessor => initialize(accessor.get(themeServiceId), accessor.get(contextKeyServiceId), accessor.get(controls.extensionServiceId)).initial),
    commands.registerCommand('codexWeb.toggleTheme', accessor => {
      initialize(accessor.get(themeServiceId), accessor.get(contextKeyServiceId), accessor.get(controls.extensionServiceId));
      toggleAppearance();
    }),
  ];
  const command = { id: 'codexWeb.toggleTheme', title: '切换明暗', icon: { id: 'color-mode' } };
  registrations.push(
    controls.registry.addCommand(command),
    controls.registry.appendMenuItem(controls.ids.TitleBar, { command: { ...command, title: '切换日间模式' }, when: controls.expression.has('codexWeb.darkTheme'), group: 'navigation', order: 0 }),
    controls.registry.appendMenuItem(controls.ids.TitleBar, { command: { ...command, title: '开启黑夜模式' }, when: controls.expression.not('codexWeb.darkTheme'), group: 'navigation', order: 0 }),
    controls.registry.appendMenuItem(controls.ids.CommandPalette, { command }),
  );
  class AppearanceContribution {
    constructor(service, keys, extensions) {
      initialize(service, keys, extensions);
    }
  }
  themeServiceId(AppearanceContribution, undefined, 0);
  contextKeyServiceId(AppearanceContribution, undefined, 1);
  controls.extensionServiceId(AppearanceContribution, undefined, 2);
  registerContribution('codexWeb.appearance', AppearanceContribution, 2);
  return { dispose() {
    webview._createElement = createElement;
    webview._initElement = initializeElement;
    webview.style = styleWebview;
    unsubscribeBackground();
    elements.clear();
    registrations.forEach(registration => registration.dispose());
    runtime?.unsubscribe();
    runtime?.subscription.dispose();
  } };
}
