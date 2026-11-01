const vscode = require('vscode');

exports.activate = async (context) => {
  const themeReady = vscode.commands.executeCommand('codexWeb.initializeTheme');
  const activateOfficial = async () => {
    const official = vscode.extensions.getExtension('openai.chatgpt');
    if (!official) throw new Error('没有找到官方 Codex 插件。');
    await official.activate();
  };
  const focus = async () => {
    await activateOfficial();
    await vscode.commands.executeCommand('chatgpt.openSidebar');
    await vscode.commands.executeCommand('workbench.action.maximizeAuxiliaryBar');
  };
  context.subscriptions.push(vscode.commands.registerCommand('codexWeb.focus', focus));
  const focusClaude = async () => {
    const official = vscode.extensions.getExtension('anthropic.claude-code');
    if (!official) throw new Error('没有找到官方 Claude Code 插件。');
    await official.activate();
    await vscode.commands.executeCommand('claude-vscode.sidebar.open');
    await vscode.commands.executeCommand('workbench.action.maximizeAuxiliaryBar');
  };
  context.subscriptions.push(vscode.commands.registerCommand('codexWeb.focusClaude', focusClaude));
  const focusCopilot = async () => {
    const official = vscode.extensions.getExtension('github.copilot-chat');
    if (!official) throw new Error('没有找到官方 Copilot 插件。');
    await official.activate();
    await vscode.commands.executeCommand('workbench.panel.chat.view.copilot.focus');
    await vscode.commands.executeCommand('workbench.action.maximizeAuxiliaryBar');
  };
  context.subscriptions.push(vscode.commands.registerCommand('codexWeb.focusCopilot', focusCopilot));
  const focusQoder = async () => {
    const official = vscode.extensions.getExtension('alibaba-cloud.tongyi-lingma');
    if (!official) throw new Error('没有找到官方 Qoder CN 插件。');
    await official.activate();
    await vscode.commands.executeCommand('QoderCN.Chat.focus');
    await vscode.commands.executeCommand('workbench.action.maximizeAuxiliaryBar');
  };
  context.subscriptions.push(vscode.commands.registerCommand('codexWeb.focusQoder', focusQoder));
  let initialization;
  const initializeLayout = async () => {
    await activateOfficial();
    if (!context.workspaceState.get('layoutInitialized', false)) {
      await focus();
      await context.workspaceState.update('layoutInitialized', true);
    }
  };
  const initializeWhenReady = () => {
    if (!vscode.workspace.isTrusted || !vscode.extensions.getExtension('openai.chatgpt')) return;
    return initialization ??= initializeLayout();
  };
  context.subscriptions.push(
    vscode.workspace.onDidGrantWorkspaceTrust(initializeWhenReady),
    vscode.extensions.onDidChange(initializeWhenReady),
  );
  await Promise.all([themeReady, initializeWhenReady()]);
};
