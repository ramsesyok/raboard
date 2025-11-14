import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel('raBoard');
  outputChannel.appendLine('raBoard extension activated.');

  const openTimeline = vscode.commands.registerCommand('raBoard.openTimeline', async () => {
    outputChannel.appendLine('Open Timeline command invoked.');
    await vscode.window.showInformationMessage('raBoard timeline will appear here.');
  });

  context.subscriptions.push(openTimeline, outputChannel);
}

export function deactivate(): void {
  // Reserved for cleanup logic when the extension is deactivated.
}
