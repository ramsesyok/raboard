import { promises as fs } from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { getConfig, wjoin } from '../config';
import { ensureRoomReady } from '../readiness';

export interface SpoolAttachment {
  readonly relPath: string;
  readonly mime: string;
  readonly display: 'inline' | 'link';
}

export interface SpoolMessage {
  readonly id: string;
  readonly ts: string;
  readonly room: string;
  readonly from: string;
  readonly type: 'msg';
  readonly text: string;
  readonly replyTo: string | null;
  readonly attachments: SpoolAttachment[];
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[.:]/g, '-');
}

function createTempName(name: string): string {
  return `${name}.${randomBytes(6).toString('hex')}.tmp`;
}

export async function writeJsonAtomic(dir: string, name: string, obj: unknown): Promise<void> {
  const finalPath = path.win32.isAbsolute(name) ? name : wjoin(dir, name);
  const directory = path.win32.dirname(finalPath);
  const baseName = path.win32.basename(finalPath);
  const tmpName = createTempName(baseName);
  const tmpPath = wjoin(directory, tmpName);
  const payload = `${JSON.stringify(obj)}\n`;

  await fs.writeFile(tmpPath, payload, { encoding: 'utf8' });
  await fs.rename(tmpPath, finalPath);
}

export async function postMessage(
  room: string,
  from: string,
  text: string,
  attachments: SpoolAttachment[] = []
): Promise<SpoolMessage> {
  const trimmedText = text.trim();
  if (!trimmedText) {
    throw new Error('Message text cannot be empty.');
  }

  const author = from.trim();
  if (!author) {
    throw new Error('Sender name cannot be empty.');
  }

  const { shareRoot } = getConfig();
  await ensureRoomReady(room, shareRoot);

  const now = new Date();
  const id = randomBytes(4).toString('hex');
  const fileName = `${formatTimestamp(now)}_${id}.json`;
  const message: SpoolMessage = {
    id,
    ts: now.toISOString(),
    room,
    from: author,
    type: 'msg',
    text: trimmedText,
    replyTo: null,
    attachments: attachments.map((attachment) => ({ ...attachment })),
  };

  const msgsDir = wjoin(shareRoot, 'rooms', room, 'msgs');
  await writeJsonAtomic(msgsDir, fileName, message);

  return message;
}
