import { promises as fs } from 'fs';
import type { Dirent } from 'fs';
import { wjoin } from '../config';
import { writeJsonAtomic } from './spool';
import type { PresenceEntry } from '../../../src/types';

export const HEARTBEAT_INTERVAL_MS = 30_000;
export const PRESENCE_SCAN_INTERVAL_MS = 5_000;

export interface HeartbeatOptions {
  readonly now?: Date;
}

export interface ScanPresenceOptions {
  readonly now?: Date;
  readonly onError?: (message: string) => void;
}

export class PresenceUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PresenceUnavailableError';
  }
}

function sanitizeUserName(user: string): string {
  const trimmed = user.trim();
  const sanitized = trimmed.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!sanitized) {
    throw new Error('Presence user name must contain at least one valid character.');
  }
  return sanitized;
}

function presenceDir(shareRoot: string): string {
  return wjoin(shareRoot, 'presence');
}

function toPresenceEntry(user: string, date: Date): PresenceEntry {
  return {
    user,
    ts: date.toISOString(),
  };
}

function isMissingError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export async function heartbeat(
  shareRoot: string,
  user: string,
  options: HeartbeatOptions = {}
): Promise<void> {
  const now = options.now ?? new Date();
  const entry = toPresenceEntry(user, now);
  const fileName = `${sanitizeUserName(entry.user)}.json`;
  try {
    await writeJsonAtomic(presenceDir(shareRoot), fileName, entry);
  } catch (error) {
    if (isMissingError(error)) {
      throw new PresenceUnavailableError('Presence directory is unavailable.');
    }
    throw error;
  }
}

function shouldInclude(mtime: Date, now: Date, ttlSec: number): boolean {
  const ageMs = now.getTime() - mtime.getTime();
  return ageMs <= ttlSec * 1000;
}

function readUserName(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : 'unknown';
}

function deriveFallbackName(name: string): string {
  return name.replace(/\.json$/i, '');
}

export async function scanPresence(
  shareRoot: string,
  ttlSec: number,
  options: ScanPresenceOptions = {}
): Promise<string[]> {
  const now = options.now ?? new Date();
  const dir = presenceDir(shareRoot);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissingError(error)) {
      throw new PresenceUnavailableError('Presence directory is unavailable.');
    }
    throw error;
  }

  const users: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) {
      continue;
    }

    const filePath = wjoin(dir, entry.name);
    let stats;
    try {
      stats = await fs.stat(filePath);
    } catch (error) {
      options.onError?.(`Failed to read presence entry ${filePath}: ${String(error)}`);
      continue;
    }

    if (!shouldInclude(stats.mtime, now, ttlSec)) {
      continue;
    }

    let label: string | undefined;
    try {
      const payload = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(payload) as Partial<PresenceEntry>;
      if (typeof parsed.user === 'string') {
        label = readUserName(parsed.user);
      }
    } catch (error) {
      options.onError?.(`Failed to parse presence entry ${filePath}: ${String(error)}`);
    }

    users.push(label ?? deriveFallbackName(entry.name));
  }

  return users
    .map((user) => user.trim())
    .filter((user, index, array) => user.length > 0 && array.indexOf(user) === index)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}
