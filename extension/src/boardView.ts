import * as vscode from 'vscode';
import type { RaBoardConfig } from './config';

export interface TimelineAttachment {
  readonly relPath: string;
  readonly display: 'inline' | 'link';
  readonly fileUri?: vscode.Uri;
}

export interface TimelineMessage {
  readonly id: string;
  readonly ts: string;
  readonly room: string;
  readonly from: string;
  readonly text: string;
  readonly attachments: readonly TimelineAttachment[];
}

interface WebviewTimelineAttachment {
  readonly relPath: string;
  readonly display: 'inline' | 'link';
  readonly src?: string;
  readonly href?: string;
}

interface WebviewTimelineMessage {
  readonly id: string;
  readonly ts: string;
  readonly room: string;
  readonly from: string;
  readonly text: string;
  readonly attachments: readonly WebviewTimelineAttachment[];
}

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

type MessageFactory = (webview: vscode.Webview) => unknown;
interface RawMessagePayload {
  readonly kind: 'raw';
  readonly value: unknown;
}

type PendingMessage = MessageFactory | RawMessagePayload;

function createRawMessage(value: unknown): RawMessagePayload {
  return { kind: 'raw', value };
}

function resolvePendingMessage(webview: vscode.Webview, message: PendingMessage): unknown {
  if (typeof message === 'function') {
    return message(webview);
  }
  return message.value;
}

export type SendMessageHandler = (text: string) => Promise<TimelineMessage>;

export class BoardViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'raBoard.view';

  private webview: vscode.Webview | undefined;
  private pendingMessages: PendingMessage[] = [];

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly output: vscode.OutputChannel,
    private readonly getConfig: () => RaBoardConfig | undefined,
    private readonly onSendMessage?: SendMessageHandler
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    this.webview = webviewView.webview;

    const config = this.getConfig();
    if (config) {
      void this.postRawMessage({ type: 'config', maxInlinePx: config.maxInlinePx });
    }

    if (this.pendingMessages.length > 0) {
      const backlog = this.pendingMessages.splice(0);
      for (const message of backlog) {
        const payload = resolvePendingMessage(this.webview, message);
        void this.webview.postMessage(payload);
      }
    }

    webviewView.webview.onDidReceiveMessage((message: ViewMessage) => {
      void this.handleMessage(message);
    });
  }

  private async handleMessage(message: ViewMessage): Promise<void> {
    switch (message.type) {
      case 'send': {
        this.output.appendLine('Webview requested to send a message.');
        await this.handleSendMessage(message.text);
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

  private async handleSendMessage(text: string | undefined): Promise<void> {
    const trimmedText = text?.trim() ?? '';
    if (!trimmedText) {
      void vscode.window.showErrorMessage('Message text cannot be empty.');
      return;
    }

    if (!this.onSendMessage) {
      void vscode.window.showErrorMessage('Sending messages is not available.');
      return;
    }

    try {
      const posted = await this.onSendMessage(trimmedText);
      await this.postMessage((webview) => ({
        type: 'send',
        message: this.mapTimelineMessage(webview, posted),
      }));
      this.output.appendLine(`Message ${posted.id} posted to room "${posted.room}".`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`Failed to post message: ${detail}`);
      void vscode.window.showErrorMessage(`Failed to send message: ${detail}`);
    }
  }

  public async resetTimeline(messages: TimelineMessage[]): Promise<void> {
    await this.postMessage((webview) => ({
      type: 'reset',
      messages: messages.map((message) => this.mapTimelineMessage(webview, message)),
    }));
  }

  public async appendTimeline(messages: TimelineMessage[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    await this.postMessage((webview) => ({
      type: 'messages',
      append: messages.map((message) => this.mapTimelineMessage(webview, message)),
    }));
  }

  public async updatePresence(users: readonly string[]): Promise<void> {
    await this.postRawMessage({ type: 'presence', users: [...users] });
  }

  private async postMessage(message: PendingMessage): Promise<void> {
    if (this.webview) {
      const payload = resolvePendingMessage(this.webview, message);
      await this.webview.postMessage(payload);
      return;
    }

    this.pendingMessages.push(message);
  }

  private async postRawMessage(value: unknown): Promise<void> {
    await this.postMessage(createRawMessage(value));
  }

  private mapTimelineMessage(
    webview: vscode.Webview,
    message: TimelineMessage
  ): WebviewTimelineMessage {
    const attachments = message.attachments.map<WebviewTimelineAttachment>((attachment) => {
      const href = attachment.fileUri
        ? webview.asWebviewUri(attachment.fileUri).toString()
        : undefined;
      return {
        relPath: attachment.relPath,
        display: attachment.display,
        src: attachment.display === 'inline' && href ? href : undefined,
        href,
      };
    });

    return {
      id: message.id,
      ts: message.ts,
      room: message.room,
      from: message.from,
      text: message.text,
      attachments,
    };
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
