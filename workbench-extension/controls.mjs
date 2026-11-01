import { installIndexedDBLifetime } from './codex-web-database.js?v=1';
import { installWorkbenchAppearance, installWebviewVisibility } from '/workbench/codex-appearance.mjs';
import { installMicrophonePermission } from './codex-web-microphone.js?v=1';
import { installTouchTabReordering } from './codex-web-tabs.js?v=1';
import { installResponsiveDialogs } from './codex-web-dialogs.js?v=1';

export function installWorkbenchControls(commands, themeServiceId, IndexedDB, contextKeyServiceId, controls, registerContribution) {
  const responsiveDialogs = installResponsiveDialogs(controls);
  const compactTabsStyle = document.createElement('style');
  compactTabsStyle.textContent = `.part.auxiliarybar .composite-bar [role="tab"] { touch-action: none; }
  .part.auxiliarybar .composite-bar [data-codex-drop="before"] { box-shadow: inset 2px 0 var(--vscode-focusBorder); }
  .part.auxiliarybar .composite-bar [data-codex-drop="after"] { box-shadow: inset -2px 0 var(--vscode-focusBorder); }
  .codex-web-tab-drag { position: fixed; z-index: 100000; pointer-events: none; transform: translateX(-50%);
    padding: 6px 10px; border: 1px solid var(--vscode-focusBorder); border-radius: 4px;
    background: var(--vscode-sideBar-background); color: var(--vscode-foreground); font-size: 12px; }
  @media (max-width: 600px) {
    .monaco-workbench .part.auxiliarybar > .title > .composite-bar-container {
      flex: 3 1 0; min-width: 0; overflow-x: auto; overflow-y: hidden; scrollbar-width: none; touch-action: none; }
    .monaco-workbench .part.auxiliarybar > .title > .composite-bar-container::-webkit-scrollbar { display: none; }
    .monaco-workbench .part.auxiliarybar > .title > .composite-bar-container > .composite-bar {
      width: max-content; max-width: none; }
    .monaco-workbench .part.auxiliarybar > .title > .composite-bar-container .actions-container { gap: 4px; }
    .monaco-workbench .part.auxiliarybar > .title > .composite-bar-container > .composite-bar > .monaco-action-bar .action-item:not(.icon) {
      padding: 0; height: 32px; flex: none;
    }
    .monaco-workbench .part.auxiliarybar > .title > .composite-bar-container .action-label:not(.codicon) {
      display: flex; align-items: center; box-sizing: border-box; height: 28px; line-height: 28px;
      margin: 2px 0; padding: 0 10px !important; font-size: 13px !important; white-space: nowrap;
      border-radius: 6px !important; width: auto; max-width: none; }
    .monaco-workbench .part.auxiliarybar > .title > .composite-bar-container .checked > .action-label:not(.codicon) {
      background-color: var(--vscode-list-inactiveSelectionBackground); color: var(--vscode-foreground) !important; }
    .monaco-workbench .part.auxiliarybar.pane-composite-part > .title.has-composite-bar > .title-actions {
      flex: 1 1 0; width: auto; min-width: 28px !important; padding-left: 0; }
    .monaco-workbench .part.auxiliarybar > .title > .title-actions .action-item:has(.separator) { display: none; }
  }`;
  document.head.append(compactTabsStyle);
  // 右侧标签独立显示，最左侧图标栏继续使用原生设置。
  const auxiliaryBar = controls.auxiliaryBarPart.prototype;
  const resolveAuxiliaryConfiguration = auxiliaryBar.resolveConfiguration;
  auxiliaryBar.resolveConfiguration = function () {
    const configuration = resolveAuxiliaryConfiguration.call(this);
    return configuration.position === 'hidden' ? { ...configuration, position: 'default' } : configuration;
  };
  const layoutCompositeBar = auxiliaryBar.layoutCompositeBar;
  const getToolbarWidth = auxiliaryBar.getToolbarWidth;
  auxiliaryBar.getToolbarWidth = function () {
    if (window.innerWidth > 600 || !this.element) return getToolbarWidth.call(this);
    const items = this.element.querySelectorAll(':scope > .title > :is(.title-actions, .global-actions) [role="button"]');
    return [...items].reduce((width, item) => {
      const rect = item.getBoundingClientRect();
      return width + (rect.width > 0 ? rect.width + 4 : 0);
    }, 4);
  };
  const measuredCompact = new WeakMap();
  const touchTabs = new Map();
  auxiliaryBar.layoutCompositeBar = function () {
    const compact = window.innerWidth <= 600;
    const bar = this.paneCompositeBar.value?.compositeBar;
    if (bar && measuredCompact.get(bar) !== compact) {
      measuredCompact.set(bar, compact);
      bar.recomputeSizes();
    }
    const result = layoutCompositeBar.call(this);
    if (bar && compact && bar.dimension) {
      const width = bar.getCompositeBarItems().filter(item => item.visible && item.pinned)
        .reduce((total, item) => total + bar.compositeSizeInBar.get(item.id) + 4, 4);
      bar.layout(new bar.dimension.constructor(Math.max(width, bar.dimension.width), bar.dimension.height));
    }
    if (bar && !touchTabs.has(this)) {
      const touch = installTouchTabReordering(this);
      let frame;
      const schedule = () => {
        if (frame !== undefined) return;
        frame = requestAnimationFrame(() => {
          frame = undefined;
          this.layoutCompositeBar();
        });
      };
      const observer = new MutationObserver(schedule);
      observer.observe(this.element.querySelector(':scope > .title > .title-actions'), { childList: true, subtree: true });
      touchTabs.set(this, { dispose() {
        observer.disconnect();
        if (frame !== undefined) cancelAnimationFrame(frame);
        touch.dispose();
      } });
      schedule();
    }
    return result;
  };
  installIndexedDBLifetime(IndexedDB);
  const microphonePermission = installMicrophonePermission(controls.webviewElement);
  const appearance = installWorkbenchAppearance(commands, themeServiceId, contextKeyServiceId, controls, registerContribution);
  const webviewVisibility = installWebviewVisibility(controls.overlayWebview);
  class PortsView {
    constructor(keys) {
      keys.createKey('forwardedPortsViewEnabled', true).set(true);
    }
  }
  contextKeyServiceId(PortsView, undefined, 0);
  registerContribution('codexWeb.portsView', PortsView, 2);
  class ActivityBarVisibility {
    constructor(layout, keys) {
      const visible = keys.createKey('codexWeb.activityBarVisible', false);
      const compact = keys.createKey('codexWeb.compactHeader', window.innerWidth <= 600);
      const update = () => {
        visible.set(layout.isVisible('workbench.parts.activitybar'));
        compact.set(window.innerWidth <= 600);
      };
      this.subscription = layout.onDidChangePartVisibility(update);
      window.addEventListener('resize', update);
      this.onResize = update;
      update();
    }
    dispose() {
      this.subscription.dispose();
      window.removeEventListener('resize', this.onResize);
    }
  }
  controls.layoutServiceId(ActivityBarVisibility, undefined, 0);
  contextKeyServiceId(ActivityBarVisibility, undefined, 1);
  registerContribution('codexWeb.activityBarVisibility', ActivityBarVisibility, 2);
  class NotificationNavigation {
    constructor(urlService, extensions) {
      const notify = message => window.CodexNotifications?.postMessage(JSON.stringify(message));
      window.codexOpenNotificationThread = async threadId => {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)) {
          throw new Error('通知中的会话标识无效。');
        }
        await extensions.whenInstalledExtensionsRegistered();
        await extensions.activateByEvent('onUri:openai.chatgpt');
        const uri = controls.uri.from({ scheme: 'vscode', authority: 'openai.chatgpt', path: `/local/${threadId}` });
        if (!await urlService.open(uri, { trusted: true })) throw new Error('工作台无法打开通知中的会话。');
        notify({ type: 'opened', threadId });
      };
      const configuration = JSON.parse(document.getElementById('vscode-workbench-web-configuration').getAttribute('data-settings'));
      notify({ type: 'ready', cwd: configuration.folderUri.path });
    }
  }
  controls.urlServiceId(NotificationNavigation, undefined, 0);
  controls.extensionServiceId(NotificationNavigation, undefined, 1);
  registerContribution('codexWeb.notificationNavigation', NotificationNavigation, 2);
  let runtime;
  const initialize = (accessor) => {
    if (runtime) return runtime;
    const keys = accessor.get(contextKeyServiceId);
    const fullscreen = keys.createKey('codexWeb.fullScreen', Boolean(document.fullscreenElement));
    runtime = {};
    runtime.onFullscreen = () => fullscreen.set(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', runtime.onFullscreen);
    return runtime;
  };
  let fullscreenRequest;
  const setFullscreen = (accessor, enabled) => {
    initialize(accessor);
    if (Boolean(document.fullscreenElement) === enabled) return;
    if (fullscreenRequest) return fullscreenRequest;
    fullscreenRequest = commands.getCommand('workbench.action.toggleFullScreen').handler(accessor).finally(() => {
      fullscreenRequest = undefined;
    });
    return fullscreenRequest;
  };
  let folderRequest;
  const toggleFolder = (accessor) => {
    if (folderRequest) {
      commands.getCommand('workbench.action.closeQuickOpen').handler(accessor);
      return folderRequest;
    }
    folderRequest = commands.getCommand('workbench.action.files.openFolder').handler(accessor).finally(() => {
      folderRequest = undefined;
    });
    return folderRequest;
  };
  const registrations = [
    commands.registerCommand('codexWeb.toggleActivityBar', accessor => commands.getCommand('workbench.action.toggleActivityBarVisibility').handler(accessor)),
    commands.registerCommand('codexWeb.openFolder', toggleFolder),
    commands.registerCommand('codexWeb.enterFullScreen', (accessor) => setFullscreen(accessor, true)),
    commands.registerCommand('codexWeb.exitFullScreen', (accessor) => setFullscreen(accessor, false)),
    commands.registerCommand('codexWeb.accountSettings', () => window.location.assign('/account')),
  ];
  const { registry, ids, expression } = controls;
  for (const item of registry.getMenuItems(ids.TitleBar)) {
    if (item.submenu !== ids.ChatTitleBarMenu) continue;
    const when = item.when;
    item.when = expression.false();
    registrations.push({ dispose: () => { item.when = when; } });
  }
  // 手机宽度下将助手的标题栏操作放入更多菜单。
  const compactActions = new WeakSet();
  const compactAssistantActions = () => {
    for (const menu of [ids.ViewTitle, ids.ViewContainerTitle, ids.AuxiliaryBarTitle]) {
      for (const item of registry.getMenuItems(menu)) {
        const condition = item.when?.serialize();
        if (compactActions.has(item) || !item.group?.startsWith('navigation') || !condition
          || !['workbench.panel.chat', 'QoderCN.Chat'].some(view => condition.includes(view))) continue;
        compactActions.add(item);
        const when = item.when;
        item.when = expression.and(when, expression.not('codexWeb.compactHeader'));
        registrations.push({ dispose: () => { item.when = when; } });
        registrations.push(registry.appendMenuItem(menu, {
          ...item, group: 'chat_actions', when: expression.and(when, expression.has('codexWeb.compactHeader')),
        }));
      }
    }
  };
  compactAssistantActions();
  registrations.push(registry.onDidChangeMenu(compactAssistantActions));
  registrations.push(registry.appendMenuItem(ids.AuxiliaryBarTitle, {
    command: { id: 'workbench.action.closeAuxiliaryBar', title: '关闭右侧面板', icon: { id: 'close' } },
    when: expression.equals('config.workbench.activityBar.location', 'hidden'), group: 'navigation', order: 2,
  }));
  const items = [
    { id: 'codexWeb.toggleActivityBar', title: '显示左侧图标栏', icon: { id: 'layout-activitybar-left' }, when: expression.not('codexWeb.activityBarVisible'), menu: ids.LayoutControlMenu, order: -1 },
    { id: 'codexWeb.toggleActivityBar', title: '隐藏左侧图标栏', icon: { id: 'layout-activitybar-left' }, when: expression.has('codexWeb.activityBarVisible'), menu: ids.LayoutControlMenu, order: -1 },
    { id: 'codexWeb.openFolder', title: '打开文件夹', icon: { id: 'folder-opened' }, order: -1 },
    { id: 'codexWeb.enterFullScreen', title: '进入全屏', icon: { id: 'screen-full' }, when: expression.not('codexWeb.fullScreen'), order: 1 },
    { id: 'codexWeb.exitFullScreen', title: '退出全屏', icon: { id: 'screen-normal' }, when: expression.has('codexWeb.fullScreen'), order: 1 },
    { id: 'codexWeb.accountSettings', title: '账户设置', icon: { id: 'account' }, order: 2 },
  ];
  for (const { when, order, menu = ids.TitleBar, ...command } of items) {
    registrations.push(
      registry.addCommand(command),
      registry.appendMenuItem(menu, { command, when, group: 'navigation', order }),
      registry.appendMenuItem(ids.CommandPalette, { command, when }),
    );
  }
  return { dispose: () => {
    compactTabsStyle.remove();
    responsiveDialogs.dispose();
    auxiliaryBar.resolveConfiguration = resolveAuxiliaryConfiguration;
    auxiliaryBar.layoutCompositeBar = layoutCompositeBar;
    auxiliaryBar.getToolbarWidth = getToolbarWidth;
    registrations.forEach((registration) => registration.dispose());
    appearance.dispose();
    webviewVisibility.dispose();
    for (const registration of touchTabs.values()) registration.dispose();
    microphonePermission.dispose();
    delete window.codexOpenNotificationThread;
    if (runtime) document.removeEventListener('fullscreenchange', runtime.onFullscreen);
  } };
}
