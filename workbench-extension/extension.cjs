const vscode = require('vscode');

exports.activate = async (context) => {
  const focus = async () => {
    await vscode.commands.executeCommand('chatgpt.openSidebar');
    await vscode.commands.executeCommand('workbench.action.maximizeAuxiliaryBar');
  };
  context.subscriptions.push(vscode.commands.registerCommand('codexWeb.focus', focus));
  await focus();
};
