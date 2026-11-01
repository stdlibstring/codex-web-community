const key = 'codex-web-browser-theme';
const media = matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set();

function systemTheme() {
  return media.matches ? 'dark' : 'light';
}

function browserChoice() {
  const saved = localStorage.getItem(key);
  if (saved === null) return null;
  const choice = JSON.parse(saved);
  if (!choice || !['dark', 'light'].includes(choice.theme) || !['dark', 'light'].includes(choice.system)) {
    throw new Error('浏览器外观设置格式错误。');
  }
  return choice;
}

export function getAppearance() {
  const native = window.codexNativeAppearance;
  const choice = native ? null : browserChoice();
  const preference = native ? native.preference : choice && choice.system === systemTheme() ? choice.theme : 'system';
  if (!['system', 'dark', 'light'].includes(preference)) throw new Error('外观设置格式错误。');
  const theme = native ? native.theme : preference === 'system' ? systemTheme() : preference;
  if (theme !== 'dark' && theme !== 'light') throw new Error('明暗主题格式错误。');
  return { preference, theme };
}

export function toggleAppearance() {
  const theme = getAppearance().theme === 'dark' ? 'light' : 'dark';
  if (window.codexNativeAppearance) {
    window.codexNativeAppearance.setPreference(theme);
    return;
  }
  localStorage.setItem(key, JSON.stringify({ theme, system: systemTheme() }));
  publish();
}

export function subscribeAppearance(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish() {
  const appearance = getAppearance();
  document.documentElement.dataset.appearance = appearance.preference;
  document.documentElement.dataset.theme = appearance.theme;
  document.documentElement.style.colorScheme = appearance.theme;
  let color = document.querySelector('meta[name="theme-color"]');
  if (!color) {
    color = document.createElement('meta');
    color.name = 'theme-color';
    document.head.append(color);
  }
  color.content = appearance.theme === 'dark' ? '#212121' : '#ffffff';
  for (const listener of listeners) listener(appearance);
}

media.addEventListener('change', () => {
  if (window.codexNativeAppearance) return;
  const saved = browserChoice();
  if (saved && saved.system !== systemTheme()) localStorage.removeItem(key);
  publish();
});
window.addEventListener('storage', event => {
  if (event.key === key || event.key === null) publish();
});
window.addEventListener('codex-native-appearance', publish);
if (!window.codexNativeAppearance) {
  const saved = browserChoice();
  if (saved && saved.system !== systemTheme()) localStorage.removeItem(key);
}
publish();
