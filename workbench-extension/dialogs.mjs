export function installResponsiveDialogs({ resizableElement, splitView, settingsEditor }) {
  const style = document.createElement('style');
  style.textContent = `@media (max-width: 600px) {
    .monaco-workbench .monaco-dialog-box { box-sizing: border-box; width: calc(100vw - 24px); min-width: 0;
      max-width: calc(100vw - 24px); max-height: calc(100dvh - 24px); padding: 12px; }
    .monaco-workbench .monaco-dialog-box .dialog-message-row { padding: 20px 4px 0; flex-shrink: 1; }
    .monaco-workbench .monaco-dialog-box .dialog-message-container { min-width: 0; padding: 0 0 0 8px; }
    .monaco-workbench .monaco-dialog-box .dialog-message-text,
    .monaco-workbench .monaco-dialog-box .dialog-message-detail { overflow-wrap: anywhere; min-width: 0; }
    .monaco-workbench .monaco-dialog-box > .dialog-buttons-row { flex-shrink: 0; padding-top: 12px; }
    .monaco-workbench .monaco-dialog-box > .dialog-buttons-row > .dialog-buttons {
      flex-direction: column; align-items: stretch; margin: 0; overflow: visible; min-width: 0; }
    .monaco-workbench .monaco-dialog-box > .dialog-buttons-row > .dialog-buttons > .monaco-button {
      box-sizing: border-box; width: 100%; min-height: 32px; margin: 4px 0; white-space: normal;
      overflow-wrap: anywhere; height: auto; }
    .monaco-workbench .settings-editor { display: flex; flex-direction: column; min-width: 0; }
    .monaco-workbench .settings-editor > .settings-header { flex: none; width: 100%; padding: 3px 12px 0; }
    .monaco-workbench .settings-editor > .settings-body { flex: 1; min-height: 0; }
    .monaco-workbench .settings-editor .search-container { display: flex; flex-direction: column; }
    .monaco-workbench .settings-editor .search-container .search-container-widgets {
      position: static; height: auto; justify-content: flex-end; margin-top: 4px; }
    .monaco-workbench .settings-editor .settings-target-container { min-width: 0; width: 100%; }
    .monaco-workbench .settings-tabs-widget .actions-container { display: flex; flex-wrap: wrap; }
    .monaco-workbench .settings-tabs-widget .action-item { max-width: 100%; }
    .monaco-workbench .settings-tabs-widget .action-label { white-space: normal; overflow-wrap: anywhere; }
    .monaco-workbench .settings-editor.narrow-width > .settings-body .settings-tree-container .monaco-list-row .monaco-tl-contents {
      padding-left: 16px; padding-right: 8px; }
    .monaco-workbench .settings-editor .setting-item-contents { padding-left: 8px; padding-right: 8px; }
    .monaco-workbench .settings-editor .setting-item-contents .setting-item-title { display: block;
      overflow: visible; overflow-wrap: anywhere; }
    .monaco-workbench .settings-editor .setting-item-description { overflow-wrap: anywhere; }
    .monaco-workbench .settings-editor .setting-item-control { max-width: 100%; min-width: 0; }
    .monaco-workbench .settings-editor .setting-item-control :is(input, select, .monaco-inputbox, .monaco-select-box) {
      max-width: 100%; box-sizing: border-box; }
  }`;
  document.head.append(style);
  const resize = resizableElement.prototype.layout;
  const minimums = new WeakMap();
  resizableElement.prototype.layout = function (height = this.size.height, width = this.size.width) {
    if (this.domNode.classList.contains('modal-editor-resizable')) {
      if (!minimums.has(this)) minimums.set(this, this.minSize);
      const minimum = minimums.get(this);
      this.minSize = innerWidth <= 600
        ? new minimum.constructor(Math.min(minimum.width, width), Math.min(minimum.height, height)) : minimum;
    }
    return resize.call(this, height, width);
  };
  const addView = splitView.prototype.addView;
  splitView.prototype.addView = function (view, ...args) {
    if (view.element.classList.contains('settings-tree-container')) {
      const minimum = view.minimumSize;
      Object.defineProperty(view, 'minimumSize', { get: () => innerWidth <= 600 ? 0 : minimum });
    }
    return addView.call(this, view, ...args);
  };
  const layout = settingsEditor.prototype.layout;
  const layoutSplitView = settingsEditor.prototype.layoutSplitView;
  settingsEditor.prototype.layoutSplitView = function (dimension) {
    const result = layoutSplitView.call(this, dimension);
    if (innerWidth <= 600 && this.isVisible()) {
      const height = Math.max(0, this.rootElement.getBoundingClientRect().bottom - this.settingsTreeContainer.getBoundingClientRect().top);
      this.splitView.el.style.height = `${height}px`;
      this.splitView.layout(this.bodyContainer.clientWidth, height);
    }
    return result;
  };
  settingsEditor.prototype.layout = function (dimension) {
    const result = layout.call(this, dimension);
    if (innerWidth <= 600 && this.isVisible()) {
      this.searchWidget.layout(new dimension.constructor(Math.max(0, this.searchContainer.clientWidth - 2), 20));
      this.layoutSplitView(dimension);
    }
    return result;
  };
  return { dispose() {
    style.remove();
    resizableElement.prototype.layout = resize;
    splitView.prototype.addView = addView;
    settingsEditor.prototype.layout = layout;
    settingsEditor.prototype.layoutSplitView = layoutSplitView;
  } };
}
