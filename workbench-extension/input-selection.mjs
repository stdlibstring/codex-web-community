export function installNativeInputSelection() {
  const app = navigator.userAgent.includes('CodexRemote/');
  const onContextMenu = event => {
    const touch = event.pointerType === 'touch' || event.sourceCapabilities?.firesTouchEvents;
    const target = event.target;
    if ((!app && !touch) || !(target instanceof HTMLElement)) return;
    if (!target.isContentEditable && !target.matches('input, textarea')) return;
    // Android 选择手柄会发送 mouse 类型的菜单事件，交由系统文字菜单处理。
    event.stopPropagation();
  };
  document.addEventListener('contextmenu', onContextMenu);
  return { dispose: () => {
    document.removeEventListener('contextmenu', onContextMenu);
  } };
}
