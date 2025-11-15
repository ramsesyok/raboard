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
import { showErrorToast, showInfoToast, showWarningToast } from './toast';

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
const reportedAttachmentFailures = new Set<string>();

function isDebugEnabled(): boolean {
  return currentConfig?.debug === true;
}

function logDebug(message: string): void {
  if (!isDebugEnabled()) {
    return;
  }
  outputChannel?.appendLine(`[debug] ${message}`);
}

function sanitizeConfigForOutput(config: RaBoardConfig): Record<string, unknown> {
  return {
    ...config,
    shareRoot: config.shareRoot ? '[redacted]' : '',
    userName: config.userName ? '[configured]' : '',
    notifications: {
      ...config.notifications,
      rooms: [...config.notifications.rooms],
    },
  };
}

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
    const failureKey = absolutePath.toLowerCase();
    if (!reportedAttachmentFailures.has(failureKey)) {
      reportedAttachmentFailures.add(failureKey);
      void showWarningToast(`Unable to load attachment ${relPath}.`, { detail });
    }
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
    if (!activeRoom) {
      return;
    }

    try {
      const room = activeRoom;
      const promise = loadIncremental(room);
      promise.catch((error) => {
        const detail = error instanceof Error ? error.message : String(error);
        outputChannel?.appendLine(`Polling tick failed for "${room}": ${detail}`);
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outputChannel?.appendLine(`Polling loop threw for "${activeRoom}": ${detail}`);
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
    runHeartbeatOnce().catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      outputChannel?.appendLine(`Heartbeat tick failed: ${detail}`);
    });
    heartbeatTimer = setInterval(() => {
      try {
        const promise = runHeartbeatOnce();
        promise.catch((error) => {
          const detail = error instanceof Error ? error.message : String(error);
          outputChannel?.appendLine(`Heartbeat tick failed: ${detail}`);
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        outputChannel?.appendLine(`Heartbeat timer threw: ${detail}`);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  if (!presenceScanTimer) {
    runPresenceScanOnce().catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      outputChannel?.appendLine(`Presence scan tick failed: ${detail}`);
    });
    presenceScanTimer = setInterval(() => {
      try {
        const promise = runPresenceScanOnce();
        promise.catch((error) => {
          const detail = error instanceof Error ? error.message : String(error);
          outputChannel?.appendLine(`Presence scan tick failed: ${detail}`);
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        outputChannel?.appendLine(`Presence scan timer threw: ${detail}`);
      }
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
      await showInfoToast(`Already viewing room "${room}".`);
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
    await showInfoToast(`Switched to room "${activeRoom}".`);
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
    await showErrorToast(`Failed to load timeline for "${room}".`, {
      detail,
      onRetry: async () => {
        await loadInitialTimeline(room);
      },
    });
  }
}

export async function loadIncremental(room: string): Promise<void> {
  if (!currentConfig || !outputChannel) {
    return;
  }

  const msgsDir = wjoin(currentConfig.shareRoot, 'rooms', room, 'msgs');
  const lastSeen = getLastSeenMessageName(room);
  const since = lastSeen ?? '';
  const startedAt = Date.now();
  let examined = 0;
  let loaded = 0;
  let failureDetail: string | undefined;

  try {
    const { files: newer, examined: examinedCount } = await listSince(msgsDir, since);
    examined = examinedCount;
    loaded = newer.length;

    if (newer.length === 0) {
      return;
    }

    await deliverMessages(lastSeen ? 'append' : 'reset', msgsDir, newer);
    await updateLastSeenMessageName(room, newer[newer.length - 1]);
    notificationMonitor?.markRoomRead(room);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    failureDetail = detail;
    outputChannel.appendLine(`Failed to load incremental timeline for room "${room}": ${detail}`);
  }

  if (isDebugEnabled()) {
    const durationMs = Date.now() - startedAt;
    const baseMessage = `Polling cycle for "${room}": examined ${examined}, loaded ${loaded}, duration ${durationMs}ms`;
    if (failureDetail) {
      logDebug(`${baseMessage} (failed: ${failureDetail})`);
    } else {
      logDebug(baseMessage);
    }
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel('raBoard');
  outputChannel.appendLine('raBoard extension activated.');

  const config = getConfig();
  currentConfig = config;
  globalState = context.globalState;
  if (config.debug) {
    logDebug('Debug logging enabled.');
  }
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
    debugLog: logDebug,
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

  const devForcePoll = vscode.commands.registerCommand('raBoard.devForcePoll', async () => {
    if (!currentConfig || !outputChannel) {
      await showErrorToast('Configuration is not available.');
      return;
    }

    const room = activeRoom;
    if (!room) {
      await showErrorToast('No active room is available.');
      return;
    }

    outputChannel.appendLine(`Force poll requested for "${room}".`);

    try {
      await loadIncremental(room);
      await showInfoToast(`Polled "${room}" for new messages.`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outputChannel.appendLine(`Force poll failed for "${room}": ${detail}`);
      await showErrorToast('Failed to force poll the active room.', { detail });
    }
  });

  const devDumpConfig = vscode.commands.registerCommand('raBoard.devDumpConfig', async () => {
    if (!outputChannel) {
      return;
    }

    const configToDump = currentConfig;
    if (!configToDump) {
      outputChannel.appendLine('Configuration is not available.');
      await showErrorToast('Configuration is not available.');
      return;
    }

    outputChannel.appendLine('raBoard configuration (sanitized):');
    const sanitized = sanitizeConfigForOutput(configToDump);
    const serialized = JSON.stringify(sanitized, null, 2);
    for (const line of serialized.split('\n')) {
      outputChannel.appendLine(line);
    }
    await showInfoToast('Sanitized configuration written to the raBoard output.');
  });

  const devInjectDummy = vscode.commands.registerCommand('raBoard.devInjectDummy', async () => {
    if (!currentConfig || !outputChannel) {
      await showErrorToast('Configuration is not available.');
      return;
    }

    const room = activeRoom;
    if (!room) {
      await showErrorToast('No active room is available.');
      return;
    }

    const now = new Date();
    const text = `Dummy message generated at ${now.toISOString()}.`;
    const author = getEffectiveUserName(currentConfig);

    if (currentConfig.debug) {
      try {
        await postMessage(room, author, text);
        outputChannel.appendLine(`Dummy spool message written for "${room}".`);
        await loadIncremental(room);
        await showInfoToast(`Dummy spool message queued for "${room}".`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`Failed to inject dummy message for "${room}": ${detail}`);
        await showErrorToast('Failed to inject dummy message.', { detail });
      }
      return;
    }

    const dummyMessage: SpoolMessage = {
      id: `dummy-${now.getTime().toString(16)}`,
      ts: now.toISOString(),
      room,
      from: author,
      type: 'msg',
      text,
      replyTo: null,
      attachments: [],
    };
    const timelineMessage = await toTimelineMessage(dummyMessage);
    if (boardViewProvider) {
      await boardViewProvider.appendTimeline([timelineMessage]);
    }
    outputChannel.appendLine(`Injected local-only dummy message for "${room}" (debug disabled).`);
    await showInfoToast('Injected local-only dummy message (not persisted).');
  });

  const markAllRead = vscode.commands.registerCommand('raBoard.markAllRead', async () => {
    if (!currentConfig || !outputChannel) {
      await showErrorToast('Configuration is not available.');
      return;
    }

    const room = activeRoom;
    if (!room) {
      await showErrorToast('No active room is available.');
      return;
    }

    const msgsDir = wjoin(currentConfig.shareRoot, 'rooms', room, 'msgs');
    let latest: string | undefined;
    try {
      const recent = await listTail(msgsDir, 1);
      latest = recent.length > 0 ? recent[recent.length - 1] : undefined;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outputChannel.appendLine(`Failed to inspect messages for "${room}": ${detail}`);
      await showErrorToast('Failed to mark room as read.', { detail });
      return;
    }

    await updateLastSeenMessageName(room, latest);
    notificationMonitor?.markRoomRead(room);

    if (latest) {
      outputChannel.appendLine(`Marked room "${room}" as read at ${latest}.`);
      await showInfoToast(`Marked "${room}" as read at ${latest}.`);
    } else {
      outputChannel.appendLine(`Marked room "${room}" as read with no messages present.`);
      await showInfoToast(`Marked "${room}" as read.`);
    }
  });

  const openTimeline = vscode.commands.registerCommand('raBoard.openTimeline', async () => {
    outputChannel.appendLine('Open Timeline command invoked.');
    await updatePresenceAvailability(await checkPresenceRoot(config.shareRoot, outputChannel));
    if (!activeRoom) {
      void showErrorToast(
        'No active room is available. Please switch to a room once it has been provisioned.'
      );
      return;
    }

    const presenceNote = presenceAvailable
      ? ''
      : ' Presence updates are disabled until the presence folder is restored.';
    await showInfoToast(`raBoard timeline for "${activeRoom}" will appear here.${presenceNote}`);
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

  const openAttachments = vscode.commands.registerCommand('raBoard.openAttachments', async () => {
    if (!currentConfig || !outputChannel) {
      void showErrorToast('Configuration is not available.');
      return;
    }

    const room = activeRoom;
    if (!room) {
      void showErrorToast('No active room is available.');
      return;
    }

    const attachmentsPath = wjoin(currentConfig.shareRoot, 'rooms', room, 'attachments');

    try {
      const stat = await fs.stat(attachmentsPath);
      if (!stat.isDirectory()) {
        throw new Error('Attachments path is not a directory.');
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outputChannel.appendLine(
        `Failed to open attachments for "${room}" at ${attachmentsPath}: ${detail}`
      );
      await showErrorToast(`Attachments folder is not available for "${room}".`, { detail });
      return;
    }

    const target = vscode.Uri.file(attachmentsPath);
    try {
      const opened = await vscode.env.openExternal(target);
      if (!opened) {
        await showWarningToast('VS Code was unable to open the attachments folder.');
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outputChannel.appendLine(
        `Opening attachments folder failed for "${room}" at ${attachmentsPath}: ${detail}`
      );
      await showErrorToast('Failed to launch the attachments folder.', { detail });
    }
  });

  const compactLogs = vscode.commands.registerCommand('raBoard.compactLogs', async () => {
    if (!currentConfig || !outputChannel) {
      void showErrorToast('Configuration is not available.');
      return;
    }

    await runCompactLogs(currentConfig, outputChannel);
  });

  const toggleDnd = vscode.commands.registerCommand('raBoard.toggleDnd', async () => {
    if (!currentConfig || !outputChannel) {
      void showErrorToast('Configuration is not available.');
      return;
    }

    const configuration = vscode.workspace.getConfiguration('raBoard');
    const nextValue = !currentConfig.notifications.dnd;

    try {
      await configuration.update('notifications.dnd', nextValue, vscode.ConfigurationTarget.Global);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outputChannel.appendLine(`Failed to update notifications.dnd: ${detail}`);
      await showErrorToast('Unable to toggle raBoard notifications DND.', { detail });
      return;
    }

    currentConfig = {
      ...currentConfig,
      notifications: {
        ...currentConfig.notifications,
        dnd: nextValue,
      },
    };

    notificationMonitor?.refreshIndicators(currentConfig);

    const message = nextValue
      ? 'raBoard notifications muted (do not disturb enabled).'
      : 'raBoard notifications unmuted.';
    outputChannel.appendLine(`Notifications DND ${nextValue ? 'enabled' : 'disabled'}.`);
    await showInfoToast(message);
  });

  context.subscriptions.push(
    openTimeline,
    switchRoom,
    openAttachments,
    compactLogs,
    toggleDnd,
    devForcePoll,
    devDumpConfig,
    devInjectDummy,
    markAllRead,
    outputChannel
  );
}

export function deactivate(): void {
  stopPolling();
  stopPresenceTimers();
  notificationMonitor?.dispose();
}

function handleRoomError(error: unknown, room: string, outputChannel: vscode.OutputChannel): void {
  if (error instanceof RoomNotReadyError) {
    const normalizeRoot = (value: string): string => {
      let normalized = value.replace(/\//g, '\\');
      while (normalized.endsWith('\\')) {
        normalized = normalized.slice(0, -1);
      }
      return normalized;
    };
    const shareRoot = normalizeRoot(currentConfig?.shareRoot ?? '\\mysv01\\board');
    const targetPath = `${shareRoot}\\rooms\\${error.room}\\{msgs,attachments,logs}`;
    const message = `Room not provisioned. Ask admin to create ${targetPath}`;
    const missingDetail = error.missing.join(', ');
    outputChannel.appendLine(
      `Room readiness check failed for "${room}": missing [${missingDetail}] under ${error.roomRoot}`
    );
    void showErrorToast(message);
    return;
  }

  outputChannel.appendLine(
    `Unexpected error while checking room "${room}": ${(error as Error).message ?? String(error)}`
  );
  throw error;
}
