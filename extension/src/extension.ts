import * as vscode from 'vscode';
import { getConfig } from './config';
import { checkPresenceRoot, ensureRoomReady, RoomNotReadyError } from './readiness';

let activeRoom: string | undefined;
let presenceAvailable = false;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel('raBoard');
  outputChannel.appendLine('raBoard extension activated.');

  const config = getConfig();

  presenceAvailable = await checkPresenceRoot(config.shareRoot, outputChannel);

  try {
    await ensureRoomReady(config.defaultRoom, config.shareRoot);
    activeRoom = config.defaultRoom;
    outputChannel.appendLine(`Active room set to "${activeRoom}".`);
  } catch (error) {
    handleRoomError(error, config.defaultRoom, outputChannel);
  }

  const openTimeline = vscode.commands.registerCommand('raBoard.openTimeline', async () => {
    outputChannel.appendLine('Open Timeline command invoked.');
    presenceAvailable = await checkPresenceRoot(config.shareRoot, outputChannel);
    if (!activeRoom) {
      void vscode.window.showErrorMessage(
        'No active room is available. Please switch to a room once it has been provisioned.'
      );
      return;
    }

    const presenceNote = presenceAvailable
      ? ''
      : ' Presence updates are disabled until the presence folder is restored.';
    await vscode.window.showInformationMessage(
      `raBoard timeline for "${activeRoom}" will appear here.${presenceNote}`
    );
  });

  const switchRoom = vscode.commands.registerCommand('raBoard.switchRoom', async () => {
    presenceAvailable = await checkPresenceRoot(config.shareRoot, outputChannel);

    const nextRoom = await vscode.window.showInputBox({
      prompt: 'Enter the room to open',
      value: activeRoom ?? config.defaultRoom,
      ignoreFocusOut: true,
    });

    const trimmedRoom = nextRoom?.trim();
    if (!trimmedRoom) {
      return;
    }

    if (trimmedRoom === activeRoom) {
      await vscode.window.showInformationMessage(`Already viewing room "${trimmedRoom}".`);
      return;
    }

    try {
      await ensureRoomReady(trimmedRoom, config.shareRoot);
      activeRoom = trimmedRoom;
      outputChannel.appendLine(`Switched to room "${activeRoom}".`);
      await vscode.window.showInformationMessage(`Switched to room "${activeRoom}".`);
    } catch (error) {
      handleRoomError(error, trimmedRoom, outputChannel);
    }
  });

  context.subscriptions.push(openTimeline, switchRoom, outputChannel);
}

export function deactivate(): void {
  // Reserved for cleanup logic when the extension is deactivated.
}

function handleRoomError(error: unknown, room: string, outputChannel: vscode.OutputChannel): void {
  if (error instanceof RoomNotReadyError) {
    const missingPaths = error.missing.map((item) =>
      item === 'room folder' ? error.roomRoot : `${error.roomRoot}\\${item}`
    );
    const message = `Room "${error.room}" cannot be opened because the following folders are missing: ${missingPaths.join(
      ', '
    )}. Please ask your raBoard administrator to provision them.`;
    outputChannel.appendLine(`Room readiness check failed for "${room}": ${message}`);
    void vscode.window.showErrorMessage(message);
    return;
  }

  outputChannel.appendLine(
    `Unexpected error while checking room "${room}": ${(error as Error).message ?? String(error)}`
  );
  throw error;
}
