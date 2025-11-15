import { promises as fs } from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import { getConfig, type RaBoardConfig, wjoin } from './config';
import {
  BoardViewProvider,
  type SwitchRoomHandler,
  type TimelineMessage,
  type TimelineAttachment,
} from './boardView';
import { checkPresenceRoot, ensureRoomReady, RoomNotReadyError } from './readiness';
import { NotificationMonitor } from './notifications';
import { listSince, listTail } from './shared/listing';
import {
  HEARTBEAT_INTERVAL_MS,
  PRESENCE_SCAN_INTERVAL_MS,
  PresenceUnavailableError,
  heartbeat as writePresenceHeartbeat,
  scanPresence,
} from './shared/presence';
import { postMessage, type SpoolMessage } from './shared/spool';
import { runCompactLogs } from './compactLogs';

let activeRoom: string | undefined;
let presenceAvailable = false;
let pollTimer: NodeJS.Timeout | undefined;
let heartbeatTimer: NodeJS.Timeout | undefined;
let presenceScanTimer: NodeJS.Timeout | undefined;
let currentConfig: RaBoardConfig | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let boardViewProvider: BoardViewProvider | undefined;
let lastPresenceUsers: string[] = [];
let notificationMonitor: NotificationMonitor | undefined;

const LAST_SEEN_STORAGE_KEY = 'raBoard.lastSeenMessageNames';
const lastSeenMessageNames = new Map<string, string>();
let globalState: vscode.Memento | undefined;

const ATTACHMENT_PATTERN = /(attachments[\\/][^\s"'`>]+?\.(?:png|jpe?g|svg))/gi;
const MAX_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.svg']);

function getLastSeenMessageName(room: string): string | undefined {
  return lastSeenMessageNames.get(room);
}

async function persistLastSeenMessageNames(): Promise<void> {
  if (!globalState) {
    return;
  }

  const serialized: Record<string, string> = {};
  for (const [room, name] of lastSeenMessageNames) {
    if (typeof name === 'string' && name.length > 0) {
      serialized[room] = name;
    }
  }

  await globalState.update(LAST_SEEN_STORAGE_KEY, serialized);
}

function restoreLastSeenMessageNames(value: unknown): void {
  lastSeenMessageNames.clear();
  if (!value || typeof value !== 'object') {
    return;
  }

  const entries = value as Record<string, unknown>;
  for (const [room, name] of Object.entries(entries)) {
    if (typeof room !== 'string' || room.trim().length === 0) {
      continue;
    }

    if (typeof name === 'string' && name.length > 0) {
      lastSeenMessageNames.set(room, name);
    }
  }
}

async function updateLastSeenMessageName(room: string, name: string | undefined): Promise<void> {
  const existing = lastSeenMessageNames.get(room);

  if (!name) {
    if (!lastSeenMessageNames.has(room)) {
      return;
    }
    lastSeenMessageNames.delete(room);
  } else {
    if (existing === name) {
      return;
    }
    lastSeenMessageNames.set(room, name);
  }

  try {
    await persistLastSeenMessageNames();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    outputChannel?.appendLine(`Failed to persist last seen message for "${room}": ${detail}`);
  }
}

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

function trimTrailingPunctuation(value: string): string {
  let result = value;
  while (result.length > 0 && /[)>.,;:!?\]]$/.test(result[result.length - 1])) {
    result = result.slice(0, -1);
  }
  return result;
}

function normalizeAttachmentRelPath(raw: string): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }

  let candidate = raw.trim();
  if (!candidate) {
    return undefined;
  }

  if (
    (candidate.startsWith('"') && candidate.endsWith('"')) ||
    (candidate.startsWith("'") && candidate.endsWith("'"))
  ) {
    candidate = candidate.slice(1, -1);
  }

  candidate = trimTrailingPunctuation(candidate);
  candidate = candidate.replace(/\\/g, '/');

  while (candidate.startsWith('./')) {
    candidate = candidate.slice(2);
  }

  if (candidate.startsWith('/')) {
    return undefined;
  }

  const lowered = candidate.toLowerCase();
  if (!lowered.startsWith('attachments/')) {
    return undefined;
  }

  const segments = candidate.split('/');
  const safeSegments: string[] = [];
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (trimmed === '.' || trimmed === '..') {
      return undefined;
    }
    safeSegments.push(trimmed);
  }

  if (safeSegments.length < 2) {
    return undefined;
  }

  safeSegments[0] = 'attachments';

  const fileName = safeSegments[safeSegments.length - 1];
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex === -1) {
    return undefined;
  }

  const ext = fileName.slice(dotIndex).toLowerCase();
  if (!MAX_IMAGE_EXTENSIONS.has(ext)) {
    return undefined;
  }

  return safeSegments.join('/');
}

function extractAttachmentRelPaths(text: string): Set<string> {
  const results = new Set<string>();
  if (typeof text !== 'string' || text.length === 0) {
    return results;
  }

  for (const match of text.matchAll(ATTACHMENT_PATTERN)) {
    const candidate = match[1] ?? match[0];
    const normalized = normalizeAttachmentRelPath(candidate);
    if (normalized) {
      results.add(normalized);
    }
  }

  return results;
}

function collectAttachmentDisplayHints(message: SpoolMessage): Map<string, 'inline' | 'link'> {
  const hints = new Map<string, 'inline' | 'link'>();
  for (const attachment of message.attachments) {
    const normalized = normalizeAttachmentRelPath(attachment.relPath);
    if (!normalized) {
      continue;
    }

    if (attachment.mime && !attachment.mime.toLowerCase().startsWith('image/')) {
      continue;
    }

    hints.set(normalized, attachment.display === 'link' ? 'link' : 'inline');
  }
  return hints;
}

async function resolveImageAttachment(
  message: SpoolMessage,
  relPath: string,
  preferredDisplay: 'inline' | 'link' | undefined
): Promise<TimelineAttachment | undefined> {
  const config = currentConfig;
  if (!config) {
    return undefined;
  }

  const segments = relPath.split('/');
  const absolutePath = wjoin(config.shareRoot, 'rooms', message.room, ...segments);

  try {
    const stat = await fs.stat(absolutePath);
    const maxBytes = config.maxImageMB * 1024 * 1024;
    const display: 'inline' | 'link' =
      preferredDisplay === 'link' || stat.size > maxBytes ? 'link' : 'inline';
    const fileUri = vscode.Uri.file(absolutePath);
    return { relPath, display, fileUri };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    outputChannel?.appendLine(
      `Unable to load attachment ${relPath} for message ${message.id}: ${detail}`
    );
    return undefined;
  }
}

async function toTimelineMessage(message: SpoolMessage): Promise<TimelineMessage> {
  const hints = collectAttachmentDisplayHints(message);
  const candidates = new Set<string>(hints.keys());
  for (const relPath of extractAttachmentRelPaths(message.text)) {
    candidates.add(relPath);
  }

  const attachments: TimelineAttachment[] = [];
  for (const relPath of candidates) {
    const resolved = await resolveImageAttachment(message, relPath, hints.get(relPath));
    if (resolved) {
      attachments.push(resolved);
    }
  }

  return {
    id: message.id,
    ts: message.ts,
    room: message.room,
    from: message.from,
    text: message.text,
    attachments,
  };
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

  const messages: TimelineMessage[] = [];
  for (const file of files) {
    const parsed = await readMessage(dir, file);
    if (parsed) {
      messages.push(await toTimelineMessage(parsed));
    }
  }

  if (kind === 'reset') {
    await view.resetTimeline(messages);
  } else if (messages.length > 0) {
    await view.appendTimeline(messages);
  }
}

async function trySetActiveRoom(
  room: string,
  options: { showAlreadyActiveMessage?: boolean; showSuccessMessage?: boolean } = {}
): Promise<boolean> {
  if (!currentConfig || !outputChannel) {
    return false;
  }

  if (room === activeRoom) {
    if (options.showAlreadyActiveMessage) {
      await vscode.window.showInformationMessage(`Already viewing room "${room}".`);
    }
    return false;
  }

  try {
    await ensureRoomReady(room, currentConfig.shareRoot);
  } catch (error) {
    handleRoomError(error, room, outputChannel);
    return false;
  }

  stopPolling();
  activeRoom = room;
  outputChannel.appendLine(`Switched to room "${activeRoom}".`);

  if (boardViewProvider) {
    await boardViewProvider.resetTimeline([]);
  }

  await loadInitialTimeline(activeRoom);

  if (boardViewProvider) {
    await boardViewProvider.announceRoom(activeRoom);
  }

  startPolling();

  if (options.showSuccessMessage) {
    await vscode.window.showInformationMessage(`Switched to room "${activeRoom}".`);
  }

  return true;
}

export async function loadInitialTimeline(room: string): Promise<void> {
  if (!currentConfig || !outputChannel) {
    return;
  }

  const msgsDir = wjoin(currentConfig.shareRoot, 'rooms', room, 'msgs');

  try {
    const recent = await listTail(msgsDir, currentConfig.initialLoadLimit);
    await deliverMessages('reset', msgsDir, recent);
    const lastSeen = recent.length > 0 ? recent[recent.length - 1] : undefined;
    await updateLastSeenMessageName(room, lastSeen);
    notificationMonitor?.markRoomRead(room);
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
  const lastSeen = getLastSeenMessageName(room);
  const since = lastSeen ?? '';

  try {
    const newer = await listSince(msgsDir, since);
    if (newer.length === 0) {
      return;
    }

    await deliverMessages(lastSeen ? 'append' : 'reset', msgsDir, newer);
    await updateLastSeenMessageName(room, newer[newer.length - 1]);
    notificationMonitor?.markRoomRead(room);
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
  globalState = context.globalState;
  const storedLastSeen = context.globalState.get<Record<string, string> | undefined>(
    LAST_SEEN_STORAGE_KEY
  );
  restoreLastSeenMessageNames(storedLastSeen);

  const handleSwitchRoomFromWebview: SwitchRoomHandler = async (room) => {
    const trimmed = room.trim();
    if (!trimmed) {
      return;
    }

    const switched = await trySetActiveRoom(trimmed);
    if (!switched && activeRoom) {
      await boardViewProvider?.announceRoom(activeRoom);
    }
  };

  boardViewProvider = new BoardViewProvider(
    context.extensionUri,
    outputChannel,
    () => currentConfig,
    handleSwitchRoomFromWebview,
    async (text) => {
      const room = activeRoom;
      if (!room) {
        throw new Error('No active room is selected.');
      }

      const author = getEffectiveUserName(config);
      const posted = await postMessage(room, author, text);
      return toTimelineMessage(posted);
    }
  );
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

  const focusRoomFromNotification = async (room: string): Promise<void> => {
    const trimmed = room.trim();
    if (!trimmed) {
      return;
    }
    await trySetActiveRoom(trimmed);
  };

  notificationMonitor = new NotificationMonitor({
    getConfig: () => currentConfig,
    getActiveRoom: () => activeRoom,
    getLastSeenMessageName,
    onFocusRoom: focusRoomFromNotification,
    onSummary: async (summary) => {
      if (boardViewProvider) {
        await boardViewProvider.updateUnreadSummary(summary);
      }
    },
    output: outputChannel,
  });
  context.subscriptions.push(notificationMonitor);

  const openUnreadRooms = vscode.commands.registerCommand('raBoard.openUnreadRoom', async () => {
    await notificationMonitor?.showUnreadQuickPick();
  });
  context.subscriptions.push(openUnreadRooms);

  await updatePresenceAvailability(await checkPresenceRoot(config.shareRoot, outputChannel));

  try {
    const switched = await trySetActiveRoom(config.defaultRoom);
    if (switched) {
      outputChannel.appendLine(`Active room set to "${config.defaultRoom}".`);
    }
  } catch (error) {
    handleRoomError(error, config.defaultRoom, outputChannel);
  }

  notificationMonitor.start();

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

    await trySetActiveRoom(trimmedRoom, {
      showAlreadyActiveMessage: true,
      showSuccessMessage: true,
    });
  });

  const compactLogs = vscode.commands.registerCommand('raBoard.compactLogs', async () => {
    if (!currentConfig || !outputChannel) {
      void vscode.window.showErrorMessage('Configuration is not available.');
      return;
    }

    await runCompactLogs(currentConfig, outputChannel);
  });

  context.subscriptions.push(openTimeline, switchRoom, compactLogs, outputChannel);
}

export function deactivate(): void {
  stopPolling();
  stopPresenceTimers();
  notificationMonitor?.dispose();
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
