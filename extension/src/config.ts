import * as path from 'path';
import * as vscode from 'vscode';

export type NotificationMode = 'both' | 'toast' | 'badge' | 'status';

export interface NotificationsConfig {
  enabled: boolean;
  mode: NotificationMode;
  rooms: string[];
  throttleMs: number;
  includeActiveRoom: boolean;
  dnd: boolean;
}

export interface RaBoardConfig {
  shareRoot: string;
  defaultRoom: string;
  userName: string;
  pollIntervalMs: number;
  presenceTtlSec: number;
  maxImageMB: number;
  maxInlinePx: number;
  initialLoadLimit: number;
  notifications: NotificationsConfig;
}

const DEFAULT_CONFIG: RaBoardConfig = {
  shareRoot: '\\\\mysv01\\board',
  defaultRoom: 'general',
  userName: '',
  pollIntervalMs: 5000,
  presenceTtlSec: 60,
  maxImageMB: 10,
  maxInlinePx: 240,
  initialLoadLimit: 200,
  notifications: {
    enabled: true,
    mode: 'both',
    rooms: [],
    throttleMs: 10000,
    includeActiveRoom: false,
    dnd: false,
  },
};

const VALID_NOTIFICATION_MODES: NotificationMode[] = ['both', 'toast', 'badge', 'status'];

export function wjoin(...segments: string[]): string {
  return path.win32.join(...segments);
}

export function getConfig(): RaBoardConfig {
  const configuration = vscode.workspace.getConfiguration('raBoard');

  const shareRoot = readString(configuration, 'shareRoot', DEFAULT_CONFIG.shareRoot);
  const defaultRoom = readString(configuration, 'defaultRoom', DEFAULT_CONFIG.defaultRoom);
  const userName = readStringAllowEmpty(configuration, 'userName', DEFAULT_CONFIG.userName);

  const pollIntervalMs = readNumber(
    configuration,
    'pollIntervalMs',
    DEFAULT_CONFIG.pollIntervalMs,
    1000
  );
  const presenceTtlSec = readNumber(
    configuration,
    'presenceTtlSec',
    DEFAULT_CONFIG.presenceTtlSec,
    15
  );
  const maxImageMB = readNumber(configuration, 'maxImageMB', DEFAULT_CONFIG.maxImageMB, 1);
  const maxInlinePx = readNumber(configuration, 'maxInlinePx', DEFAULT_CONFIG.maxInlinePx, 64);
  const initialLoadLimit = readNumber(
    configuration,
    'initialLoadLimit',
    DEFAULT_CONFIG.initialLoadLimit,
    1
  );

  const notificationsEnabled = readBoolean(
    configuration,
    'notifications.enabled',
    DEFAULT_CONFIG.notifications.enabled
  );

  const notificationsMode = readNotificationMode(
    configuration,
    'notifications.mode',
    DEFAULT_CONFIG.notifications.mode
  );

  const notificationsRooms = readRooms(
    configuration,
    'notifications.rooms',
    DEFAULT_CONFIG.notifications.rooms
  );

  const notificationsThrottleMs = readNumber(
    configuration,
    'notifications.throttleMs',
    DEFAULT_CONFIG.notifications.throttleMs,
    0
  );

  const notificationsIncludeActiveRoom = readBoolean(
    configuration,
    'notifications.includeActiveRoom',
    DEFAULT_CONFIG.notifications.includeActiveRoom
  );

  const notificationsDnd = readBoolean(
    configuration,
    'notifications.dnd',
    DEFAULT_CONFIG.notifications.dnd
  );

  return {
    shareRoot,
    defaultRoom,
    userName,
    pollIntervalMs,
    presenceTtlSec,
    maxImageMB,
    maxInlinePx,
    initialLoadLimit,
    notifications: {
      enabled: notificationsEnabled,
      mode: notificationsMode,
      rooms: notificationsRooms,
      throttleMs: notificationsThrottleMs,
      includeActiveRoom: notificationsIncludeActiveRoom,
      dnd: notificationsDnd,
    },
  };
}

function readString(
  configuration: vscode.WorkspaceConfiguration,
  key: string,
  fallback: string
): string {
  const value = configuration.get<string>(key);
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function readStringAllowEmpty(
  configuration: vscode.WorkspaceConfiguration,
  key: string,
  fallback: string
): string {
  const value = configuration.get<string>(key);
  if (typeof value !== 'string') {
    return fallback;
  }

  return value.trim();
}

function readNumber(
  configuration: vscode.WorkspaceConfiguration,
  key: string,
  fallback: number,
  minimum: number
): number {
  const value = configuration.get<number>(key);
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
    return fallback;
  }

  return value >= minimum ? value : fallback;
}

function readBoolean(
  configuration: vscode.WorkspaceConfiguration,
  key: string,
  fallback: boolean
): boolean {
  const value = configuration.get<boolean | undefined>(key);
  return typeof value === 'boolean' ? value : fallback;
}

function readNotificationMode(
  configuration: vscode.WorkspaceConfiguration,
  key: string,
  fallback: NotificationMode
): NotificationMode {
  const value = configuration.get<string | undefined>(key);
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (VALID_NOTIFICATION_MODES.includes(normalized as NotificationMode)) {
      return normalized as NotificationMode;
    }
  }

  return fallback;
}

function readRooms(
  configuration: vscode.WorkspaceConfiguration,
  key: string,
  fallback: string[]
): string[] {
  const value = configuration.get<unknown>(key);
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const rooms = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);

  return rooms;
}
