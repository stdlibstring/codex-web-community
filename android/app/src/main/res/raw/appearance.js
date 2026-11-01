(() => {
  if (window !== window.top) return;
  let { preference, theme } = window.codexNativeAppearanceInitial;
  delete window.codexNativeAppearanceInitial;
  const validate = value => {
    if (!['system', 'dark', 'light'].includes(value)) throw new Error('外观设置格式错误。');
  };
  validate(preference);
  window.codexNativeAppearance = Object.freeze({
    get preference() { return preference; },
    get theme() { return theme; },
    setPreference(value) { validate(value); window.CodexAppearance.postMessage(value); },
  });
  window.codexApplyNativeAppearance = (value, resolved) => {
    validate(value);
    if (resolved !== 'dark' && resolved !== 'light') throw new Error('明暗主题格式错误。');
    preference = value;
    theme = resolved;
    window.dispatchEvent(new Event('codex-native-appearance'));
  };
  window.CodexAppearance.postMessage('ready');
})();
