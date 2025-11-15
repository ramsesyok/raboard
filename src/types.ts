/**
 * Shared data model definitions for raBoard message and presence metadata.
 */

export interface AttachmentMeta {
  /** Original filename for the uploaded attachment. */
  name: string;
  /** MIME type reported for the attachment payload. */
  mimeType?: string;
  /** Size of the attachment payload in bytes. */
  sizeBytes?: number;
  /** Optional URL pointing to the attachment location. */
  url?: string;
}

export interface Message {
  /** Unique identifier within the message payload. */
  id: string;
  /** Timestamp associated with the message event (ISO 8601). */
  ts: string;
  /** Logical room the message belongs to. */
  room: string;
  /** Display name of the author. */
  from: string;
  /** Message type marker, currently fixed to "msg". */
  type: 'msg';
  /** Primary text body of the message. */
  text: string;
  /** Optional message identifier that this entry replies to. */
  replyTo?: string;
  /** Optional array of attachment metadata. */
  attachments?: AttachmentMeta[];
}

export interface PresenceEntry {
  /** User account represented by the presence entry. */
  user: string;
  /** Timestamp when the presence entry was last refreshed. */
  ts: string;
}

const MESSAGE_FILENAME_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_([A-Za-z0-9_-]+)\.json$/;

interface ParsedMessageFilename {
  timestampMs: number;
  randomPart: string;
}

function parseMessageFilename(filename: string): ParsedMessageFilename | undefined {
  const match = MESSAGE_FILENAME_PATTERN.exec(filename);
  if (!match) {
    return undefined;
  }

  const [datePart, timePart] = match[1].split('T');
  const [hour, minute, second, millis] = timePart.split('-');
  const isoTimestamp = `${datePart}T${hour}:${minute}:${second}.${millis}Z`;
  const parsed = Date.parse(isoTimestamp);
  const timestampMs = Number.isNaN(parsed) ? Number.NaN : parsed;

  return {
    timestampMs,
    randomPart: match[2],
  };
}

/**
 * Compare two message filenames using their encoded timestamp and random suffix.
 */
export function compareMessageFilenames(a: string, b: string): number {
  const parsedA = parseMessageFilename(a);
  const parsedB = parseMessageFilename(b);

  if (parsedA && parsedB) {
    if (!Number.isNaN(parsedA.timestampMs) && !Number.isNaN(parsedB.timestampMs)) {
      if (parsedA.timestampMs !== parsedB.timestampMs) {
        return parsedA.timestampMs - parsedB.timestampMs;
      }
    }

    if (parsedA.randomPart !== parsedB.randomPart) {
      return parsedA.randomPart.localeCompare(parsedB.randomPart);
    }
  }

  return a.localeCompare(b);
}

/**
 * Produce a lexical sort key from message timestamp and identifier.
 */
export function getMessageSortKey(message: Pick<Message, 'ts' | 'id'>): string {
  const timestamp = Date.parse(message.ts);
  if (!Number.isNaN(timestamp)) {
    const sign = timestamp < 0 ? '-' : '';
    const digits = Math.abs(timestamp).toString().padStart(13, '0');
    return `${sign}${digits}:${message.id}`;
  }

  return `${message.ts}:${message.id}`;
}
