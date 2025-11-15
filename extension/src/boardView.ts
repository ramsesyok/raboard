import * as vscode from 'vscode';

interface SendMessage {
  readonly type: 'send';
  readonly text?: string;
}

interface SwitchRoomMessage {
  readonly type: 'switch-room';
  readonly room?: string;
}

interface OpenAttachmentsMessage {
  readonly type: 'open-attachments-dir';
}

type ViewMessage = SendMessage | SwitchRoomMessage | OpenAttachmentsMessage;

export class BoardViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'raBoard.view';

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly output: vscode.OutputChannel
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message: ViewMessage) => {
      this.handleMessage(message);
    });
  }

  private handleMessage(message: ViewMessage): void {
    switch (message.type) {
      case 'send': {
        this.output.appendLine('Webview requested to send a message.');
        void vscode.window.showInformationMessage('Sending messages is not implemented yet.');
        return;
      }
      case 'switch-room': {
        this.output.appendLine('Webview requested to switch rooms.');
        void vscode.window.showInformationMessage(
          message.room
            ? `Switching to room "${message.room}" is not implemented yet.`
            : 'Switch room is not implemented yet.'
        );
        return;
      }
      case 'open-attachments-dir': {
        this.output.appendLine('Webview requested to open the attachments directory.');
        void vscode.window.showInformationMessage('Opening attachments is not implemented yet.');
        return;
      }
      default: {
        this.output.appendLine(`Received unknown message from webview: ${JSON.stringify(message)}`);
      }
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview
      .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'view.js'))
      .toString();
    const styleUri = webview
      .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'view.css'))
      .toString();

    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource}`,
      `script-src 'unsafe-inline' ${webview.cspSource}`,
      `style-src 'unsafe-inline' ${webview.cspSource}`,
      "object-src 'none'",
      "media-src 'none'",
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${styleUri}">
    <title>raBoard</title>
  </head>
  <body>
    <header class="header">
      <form id="room-form" class="room-form" autocomplete="off">
        <label class="room-label" for="room-input">Room</label>
        <input id="room-input" class="room-input" type="text" name="room" placeholder="general" />
        <button type="submit" class="button button-primary">Switch</button>
      </form>
      <button id="open-attachments" class="button" type="button">Open Attachments…</button>
    </header>
    <main id="timeline" class="timeline" aria-live="polite" aria-label="Timeline">
      <p class="timeline-placeholder">Timeline will appear here.</p>
    </main>
    <footer class="footer">
      <form id="message-form" class="message-form" autocomplete="off">
        <label class="message-label" for="message-input">Message</label>
        <input id="message-input" class="message-input" type="text" name="message" placeholder="Type a message" />
        <button type="submit" class="button button-primary">Send</button>
      </form>
      <div class="presence" aria-live="polite" aria-label="Presence">
        <span class="presence-pill">No active users</span>
      </div>
    </footer>
    <script src="${scriptUri}"></script>
  </body>
</html>`;
  }
}
