import { promises as fs } from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import { getConfig, type RaBoardConfig, wjoin } from './config';
import { BoardViewProvider } from './boardView';
import { checkPresenceRoot, ensureRoomReady, RoomNotReadyError } from './readiness';
import { listSince, listTail } from './shared/listing';
import {
  HEARTBEAT_INTERVAL_MS,
  PRESENCE_SCAN_INTERVAL_MS,
  PresenceUnavailableError,
  heartbeat as writePresenceHeartbeat,
  scanPresence,
} from './shared/presence';
import { postMessage, type SpoolMessage } from './shared/spool';

let activeRoom: string | undefined;
let presenceAvailable = false;
let pollTimer: NodeJS.Timeout | undefined;
let heartbeatTimer: NodeJS.Timeout | undefined;
let presenceScanTimer: NodeJS.Timeout | undefined;
let lastSeenMessageName: string | undefined;
let currentConfig: RaBoardConfig | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let boardViewProvider: BoardViewProvider | undefined;
let lastPresenceUsers: string[] = [];

async function readMessage(dir: string, name: string): Promise<SpoolMessage | undefined> {
  try {
    const payload = await fs.readFile(wjoin(dir, name), 'utf8');
    try {
      return JSON.parse(payload) as SpoolMessage;
    } catch (parseError) {
      const detail = parseError instanceof Error ? parseError.message : String(parseError);
      outputChannel?.appendLine(`Skipping invalid JSON in ${wjoin(dir, name)}: ${detail}`);
      return undefined;
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    outputChannel?.appendLine(`Failed to read ${wjoin(dir, name)}: ${detail}`);
    return undefined;
  }
}

function startPolling(): void {
  stopPolling();
  if (!currentConfig) {
    return;
  }

  pollTimer = setInterval(() => {
    if (activeRoom) {
      void loadIncremental(activeRoom);
    }
  }, currentConfig.pollIntervalMs);
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

function getEffectiveUserName(config: RaBoardConfig): string {
  return config.userName || os.userInfo().username;
}

function presenceArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }

  return a.every((value, index) => value === b[index]);
}

async function pushPresenceUsers(users: readonly string[]): Promise<void> {
  const normalized = users.map((user) => user.trim()).filter((user) => user.length > 0);

  if (presenceArraysEqual(lastPresenceUsers, normalized)) {
    return;
  }

  lastPresenceUsers = [...normalized];

  if (boardViewProvider) {
    await boardViewProvider.updatePresence(normalized);
  }
}

function stopPresenceTimers(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }

  if (presenceScanTimer) {
    clearInterval(presenceScanTimer);
    presenceScanTimer = undefined;
  }
}

async function handlePresenceUnavailable(): Promise<void> {
  if (!currentConfig) {
    return;
  }

  const available = await checkPresenceRoot(currentConfig.shareRoot, outputChannel);
  await updatePresenceAvailability(available);
}

async function handlePresenceError(context: string, error: unknown): Promise<void> {
  const detail = error instanceof Error ? error.message : String(error);
  outputChannel?.appendLine(`${context}: ${detail}`);

  if (error instanceof PresenceUnavailableError) {
    await handlePresenceUnavailable();
  }
}

async function runHeartbeatOnce(): Promise<void> {
  if (!currentConfig || !presenceAvailable) {
    return;
  }

  try {
    const user = getEffectiveUserName(currentConfig);
    await writePresenceHeartbeat(currentConfig.shareRoot, user);
  } catch (error) {
    await handlePresenceError('Failed to write presence heartbeat', error);
  }
}

async function runPresenceScanOnce(): Promise<void> {
  if (!currentConfig || !presenceAvailable) {
    return;
  }

  try {
    const users = await scanPresence(currentConfig.shareRoot, currentConfig.presenceTtlSec, {
      onError: (message) => outputChannel?.appendLine(message),
    });
    await pushPresenceUsers(users);
  } catch (error) {
    await handlePresenceError('Failed to scan presence', error);
  }
}

function startPresenceTimers(): void {
  if (!currentConfig || !presenceAvailable) {
    return;
  }

  if (!heartbeatTimer) {
    void runHeartbeatOnce();
    heartbeatTimer = setInterval(() => {
      void runHeartbeatOnce();
    }, HEARTBEAT_INTERVAL_MS);
  }

  if (!presenceScanTimer) {
    void runPresenceScanOnce();
    presenceScanTimer = setInterval(() => {
      void runPresenceScanOnce();
    }, PRESENCE_SCAN_INTERVAL_MS);
  }
}

async function updatePresenceAvailability(enabled: boolean): Promise<void> {
  presenceAvailable = enabled;

  if (presenceAvailable) {
    startPresenceTimers();
    return;
  }

  stopPresenceTimers();
  await pushPresenceUsers([]);
}

async function deliverMessages(
  kind: 'reset' | 'append',
  dir: string,
  files: string[]
): Promise<void> {
  const view = boardViewProvider;
  if (!outputChannel || !view) {
    return;
  }

  const messages: SpoolMessage[] = [];
  for (const file of files) {
    const parsed = await readMessage(dir, file);
    if (parsed) {
      messages.push(parsed);
    }
  }

  if (kind === 'reset') {
    await view.resetTimeline(messages);
  } else if (messages.length > 0) {
    await view.appendTimeline(messages);
  }
}

export async function loadInitialTimeline(room: string): Promise<void> {
  if (!currentConfig || !outputChannel) {
    return;
  }

  const msgsDir = wjoin(currentConfig.shareRoot, 'rooms', room, 'msgs');

  try {
    const recent = await listTail(msgsDir, currentConfig.initialLoadLimit);
    await deliverMessages('reset', msgsDir, recent);
    lastSeenMessageName = recent.length > 0 ? recent[recent.length - 1] : undefined;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`Failed to load initial timeline for room "${room}": ${detail}`);
  }
}

export async function loadIncremental(room: string): Promise<void> {
  if (!currentConfig || !outputChannel) {
    return;
  }

  const msgsDir = wjoin(currentConfig.shareRoot, 'rooms', room, 'msgs');
  const since = lastSeenMessageName ?? '';

  try {
    const newer = await listSince(msgsDir, since);
    if (newer.length === 0) {
      return;
    }

    await deliverMessages(lastSeenMessageName ? 'append' : 'reset', msgsDir, newer);
    lastSeenMessageName = newer[newer.length - 1];
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`Failed to load incremental timeline for room "${room}": ${detail}`);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel('raBoard');
  outputChannel.appendLine('raBoard extension activated.');

  const config = getConfig();
  currentConfig = config;

  boardViewProvider = new BoardViewProvider(context.extensionUri, outputChannel, async (text) => {
    const room = activeRoom;
    if (!room) {
      throw new Error('No active room is selected.');
    }

    const author = getEffectiveUserName(config);
    return postMessage(room, author, text);
  });
  const viewRegistration = vscode.window.registerWebviewViewProvider(
    BoardViewProvider.viewId,
    boardViewProvider,
    {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    }
  );
  context.subscriptions.push(viewRegistration);

  await updatePresenceAvailability(await checkPresenceRoot(config.shareRoot, outputChannel));

  try {
    await ensureRoomReady(config.defaultRoom, config.shareRoot);
    activeRoom = config.defaultRoom;
    outputChannel.appendLine(`Active room set to "${activeRoom}".`);
    await loadInitialTimeline(activeRoom);
    startPolling();
  } catch (error) {
    handleRoomError(error, config.defaultRoom, outputChannel);
  }

  const openTimeline = vscode.commands.registerCommand('raBoard.openTimeline', async () => {
    outputChannel.appendLine('Open Timeline command invoked.');
    await updatePresenceAvailability(await checkPresenceRoot(config.shareRoot, outputChannel));
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
    await updatePresenceAvailability(await checkPresenceRoot(config.shareRoot, outputChannel));

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
      stopPolling();
      activeRoom = trimmedRoom;
      lastSeenMessageName = undefined;
      outputChannel.appendLine(`Switched to room "${activeRoom}".`);
      await loadInitialTimeline(activeRoom);
      startPolling();
      await vscode.window.showInformationMessage(`Switched to room "${activeRoom}".`);
    } catch (error) {
      handleRoomError(error, trimmedRoom, outputChannel);
    }
  });

  context.subscriptions.push(openTimeline, switchRoom, outputChannel);
}

export function deactivate(): void {
  stopPolling();
  stopPresenceTimers();
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
