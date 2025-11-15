import { constants as fsConstants, promises as fs } from 'fs';
import * as vscode from 'vscode';
import { getConfig, wjoin } from './config';
import { showWarningToast } from './toast';

export const REQUIRED_ROOM_SUBDIRS = ['msgs', 'attachments', 'logs'] as const;

export class RoomNotReadyError extends Error {
  public readonly room: string;
  public readonly missing: string[];
  public readonly roomRoot: string;

  constructor(room: string, missing: string[], roomRoot: string) {
    const detail = missing.join(', ');
    super(`Room "${room}" is missing required directories: ${detail}`);
    this.name = 'RoomNotReadyError';
    this.room = room;
    this.missing = missing;
    this.roomRoot = roomRoot;
  }
}

let presenceWarningDisplayed = false;

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target, fsConstants.F_OK);
    return true;
  } catch (error) {
    return false;
  }
}

export async function ensureRoomReady(room: string, shareRoot?: string): Promise<void> {
  const { shareRoot: configShareRoot } = getConfig();
  const root = shareRoot ?? configShareRoot;
  const roomRoot = wjoin(root, 'rooms', room);

  const missing: string[] = [];

  if (!(await pathExists(roomRoot))) {
    missing.push('room folder');
  }

  for (const subdir of REQUIRED_ROOM_SUBDIRS) {
    const subdirPath = wjoin(roomRoot, subdir);
    if (!(await pathExists(subdirPath))) {
      missing.push(subdir);
    }
  }

  if (missing.length > 0) {
    throw new RoomNotReadyError(room, missing, roomRoot);
  }
}

export async function checkPresenceRoot(
  shareRoot?: string,
  outputChannel?: vscode.OutputChannel
): Promise<boolean> {
  const { shareRoot: configShareRoot } = getConfig();
  const root = shareRoot ?? configShareRoot;
  const presenceRoot = wjoin(root, 'presence');

  const exists = await pathExists(presenceRoot);
  if (exists) {
    outputChannel?.appendLine(`Presence root detected at ${presenceRoot}.`);
    return true;
  }

  if (!presenceWarningDisplayed) {
    presenceWarningDisplayed = true;
    const warning = `Presence root missing at ${presenceRoot}. Presence features are disabled.`;
    outputChannel?.appendLine(warning);
    void showWarningToast(
      'Presence features are disabled because the "presence" folder is missing. Please contact your raBoard administrator.'
    );
  }

  return false;
}
