import * as path from 'path';
import * as vscode from 'vscode';

type NotificationMode = 'both' | 'toast' | 'badge' | 'status';

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
  debug: boolean;
  notifications: NotificationsConfig;
}

const DEFAULTS: RaBoardConfig = {
  shareRoot: '\\\\mysv01\\board',
  defaultRoom: 'general',
  userName: '',
  pollIntervalMs: 5000,
  presenceTtlSec: 60,
  maxImageMB: 10,
  maxInlinePx: 240,
  initialLoadLimit: 200,
  debug: false,
  notifications: {
    enabled: true,
    mode: 'both',
    rooms: [],
    throttleMs: 10000,
    includeActiveRoom: false,
    dnd: false,
  },
};

export function getConfig(): RaBoardConfig {
  const configuration = vscode.workspace.getConfiguration('raBoard');

  return {
    shareRoot: readString(configuration, 'shareRoot', DEFAULTS.shareRoot),
    defaultRoom: readString(configuration, 'defaultRoom', DEFAULTS.defaultRoom),
    userName: readString(configuration, 'userName', DEFAULTS.userName),
    pollIntervalMs: readNumber(configuration, 'pollIntervalMs', DEFAULTS.pollIntervalMs, 1000),
    presenceTtlSec: readNumber(configuration, 'presenceTtlSec', DEFAULTS.presenceTtlSec, 15),
    maxImageMB: readNumber(configuration, 'maxImageMB', DEFAULTS.maxImageMB, 1),
    maxInlinePx: readNumber(configuration, 'maxInlinePx', DEFAULTS.maxInlinePx, 64),
    initialLoadLimit: readNumber(configuration, 'initialLoadLimit', DEFAULTS.initialLoadLimit, 1),
    debug: readBoolean(configuration, 'debug', DEFAULTS.debug),
    notifications: {
      enabled: readBoolean(configuration, 'notifications.enabled', DEFAULTS.notifications.enabled),
      mode: readMode(configuration, 'notifications.mode', DEFAULTS.notifications.mode),
      rooms: readRooms(configuration, 'notifications.rooms', DEFAULTS.notifications.rooms),
      throttleMs: readNumber(
        configuration,
        'notifications.throttleMs',
        DEFAULTS.notifications.throttleMs,
        0
      ),
      includeActiveRoom: readBoolean(
        configuration,
        'notifications.includeActiveRoom',
        DEFAULTS.notifications.includeActiveRoom
      ),
      dnd: readBoolean(configuration, 'notifications.dnd', DEFAULTS.notifications.dnd),
    },
  };
}

export function wjoin(...segments: string[]): string {
  return path.win32.join(...segments);
}

function readString(
  configuration: vscode.WorkspaceConfiguration,
  key: string,
  fallback: string
): string {
  const value = configuration.get<unknown>(key);
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function readNumber(
  configuration: vscode.WorkspaceConfiguration,
  key: string,
  fallback: number,
  minimum: number
): number {
  const value = configuration.get<unknown>(key);
  if (typeof value !== 'number' || !Number.isFinite(value) || Number.isNaN(value)) {
    return fallback;
  }

  return value >= minimum ? value : fallback;
}

function readBoolean(
  configuration: vscode.WorkspaceConfiguration,
  key: string,
  fallback: boolean
): boolean {
  const value = configuration.get<unknown>(key);
  return typeof value === 'boolean' ? value : fallback;
}

function readMode(
  configuration: vscode.WorkspaceConfiguration,
  key: string,
  fallback: NotificationMode
): NotificationMode {
  const value = configuration.get<unknown>(key);
  if (value === 'both' || value === 'toast' || value === 'badge' || value === 'status') {
    return value;
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
    return fallback;
  }

  const rooms = value
    .filter((room): room is string => typeof room === 'string')
    .map((room) => room.trim())
    .filter((room) => room.length > 0);

  return rooms.length > 0 ? rooms : [];
}
