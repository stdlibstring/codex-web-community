export function installTouchTabReordering(part) {
  const header = part.element.querySelector('.composite-bar-container');
  if (!header) throw new Error('没有找到右侧助手标签栏。');
  const compositeBar = () => part.paneCompositeBar.value.compositeBar;
  const tabs = () => [...header.querySelectorAll('[role="tab"]')];
  const identify = element => {
    const index = tabs().indexOf(element);
    return index < 0 ? undefined : compositeBar().visibleComposites[index];
  };
  let gesture;
  let suppressClickUntil = 0;
  let desiredComposite;
  let opening;
  const activate = id => {
    desiredComposite = id;
    opening ??= (async () => {
      while (desiredComposite) {
        const next = desiredComposite;
        desiredComposite = undefined;
        await compositeBar().options.openComposite(next, true);
      }
    })().finally(() => { opening = undefined; });
    return opening;
  };
  const clearTarget = () => {
    for (const tab of tabs()) tab.removeAttribute('data-codex-drop');
  };
  const finish = () => {
    if (!gesture) return;
    const { pointer, preview, timer, frame } = gesture;
    clearTimeout(timer);
    if (frame !== undefined) cancelAnimationFrame(frame);
    gesture = undefined;
    preview?.remove();
    clearTarget();
    if (header.hasPointerCapture(pointer)) header.releasePointerCapture(pointer);
    suppressClickUntil = performance.now() + 500;
  };
  const destination = (x, y) => {
    const bounds = header.getBoundingClientRect();
    if (x < bounds.left || x > bounds.right || y < bounds.top - 30 || y > bounds.bottom + 30) return;
    const target = tabs().find(tab => {
      const rect = tab.getBoundingClientRect();
      return x >= rect.left && x <= rect.right;
    });
    if (!target) return;
    const rect = target.getBoundingClientRect();
    return { tab: target, id: identify(target), before: x < rect.left + rect.width / 2 };
  };
  const showPreview = () => {
    const preview = document.createElement('div');
    preview.className = 'codex-web-tab-drag';
    preview.textContent = gesture.tab.querySelector('.action-label').textContent;
    preview.setAttribute('aria-hidden', 'true');
    document.body.append(preview);
    gesture.preview = preview;
  };
  const updatePreview = () => {
    gesture.preview.style.left = `${gesture.currentX}px`;
    gesture.preview.style.top = `${gesture.currentY + 18}px`;
    clearTarget();
    const target = destination(gesture.currentX, gesture.currentY);
    if (target?.id && target.id !== gesture.id) target.tab.dataset.codexDrop = target.before ? 'before' : 'after';
  };
  const autoScroll = () => {
    if (!gesture || gesture.mode !== 'dragging') return;
    const bounds = header.getBoundingClientRect();
    const left = gesture.currentX - bounds.left;
    const right = bounds.right - gesture.currentX;
    const direction = left < 24 ? -Math.min(12, (24 - left) / 2) : right < 24 ? Math.min(12, (24 - right) / 2) : 0;
    header.scrollLeft += direction;
    updatePreview();
    gesture.frame = requestAnimationFrame(autoScroll);
  };
  const down = event => {
    if (!['touch', 'pen'].includes(event.pointerType)) return;
    if (gesture) {
      finish();
      return;
    }
    if (!event.isPrimary) return;
    const tab = event.target.closest('[role="tab"]');
    if (!tab || !header.contains(tab)) return;
    const id = identify(tab);
    if (!id) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    gesture = { pointer: event.pointerId, id, tab, x: event.clientX, y: event.clientY,
      currentX: event.clientX, currentY: event.clientY, scroll: header.scrollLeft, mode: 'pending' };
    gesture.timer = setTimeout(() => {
      gesture.mode = 'ready';
      showPreview();
      updatePreview();
    }, 350);
    header.setPointerCapture(event.pointerId);
  };
  const move = event => {
    if (!gesture || gesture.pointer !== event.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    gesture.currentX = event.clientX;
    gesture.currentY = event.clientY;
    if (gesture.mode === 'pending') {
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) return finish();
      if (Math.abs(dx) < 8) return;
      clearTimeout(gesture.timer);
      gesture.mode = 'scrolling';
    }
    if (gesture.mode === 'scrolling') {
      header.scrollLeft = gesture.scroll - dx;
      return;
    }
    if (gesture.mode === 'ready') {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      gesture.mode = 'dragging';
      gesture.frame = requestAnimationFrame(autoScroll);
    }
    updatePreview();
  };
  const up = event => {
    if (!gesture || gesture.pointer !== event.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const { id, mode } = gesture;
    const target = destination(event.clientX, event.clientY);
    finish();
    if (mode === 'pending') {
      void activate(id);
    } else if (mode === 'dragging' && target?.id && target.id !== id) {
      compositeBar().move(id, target.id, target.before);
    }
  };
  const cancel = event => {
    if (gesture?.pointer === event.pointerId) finish();
  };
  const touch = event => {
    if (!gesture && !event.target.closest('[role="tab"]')) return;
    if (event.touches.length > 1) finish();
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const click = event => {
    if (performance.now() >= suppressClickUntil) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const key = event => { if (event.key === 'Escape') finish(); };
  const observer = new MutationObserver(() => {
    if (gesture || innerWidth > 600) return;
    const selected = header.querySelector('[role="tab"][aria-selected="true"]');
    selected?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
  observer.observe(header, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-selected'] });
  const listeners = [
    ['pointerdown', down], ['pointermove', move], ['pointerup', up],
    ['pointercancel', cancel], ['lostpointercapture', cancel],
    ['touchstart', touch], ['touchmove', touch], ['touchend', touch], ['click', click],
  ];
  for (const [type, handler] of listeners) header.addEventListener(type, handler, { capture: true, passive: false });
  window.addEventListener('resize', finish);
  window.addEventListener('blur', finish);
  window.addEventListener('keydown', key);
  return { dispose() {
    finish();
    observer.disconnect();
    for (const [type, handler] of listeners) header.removeEventListener(type, handler, true);
    window.removeEventListener('resize', finish);
    window.removeEventListener('blur', finish);
    window.removeEventListener('keydown', key);
  } };
}
