import { promises as fs } from 'fs';

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export class LockUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockUnavailableError';
  }
}

interface LockMetadata {
  detail?: string;
  createdAt: string;
  expiresAt: string;
}

interface AcquireLockOptions {
  readonly ttlMs?: number;
  readonly detail?: string;
}

async function writeLockFile(lockPath: string, metadata: LockMetadata): Promise<void> {
  const payload = `${JSON.stringify(metadata)}\n`;
  const handle = await fs.open(lockPath, 'wx');
  try {
    await handle.writeFile(payload, { encoding: 'utf8' });
  } finally {
    await handle.close();
  }
}

async function readLockMetadata(lockPath: string): Promise<LockMetadata | undefined> {
  try {
    const content = await fs.readFile(lockPath, 'utf8');
    const parsed = JSON.parse(content) as Partial<LockMetadata>;
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }
    const { createdAt, expiresAt, detail } = parsed;
    if (typeof createdAt !== 'string' || typeof expiresAt !== 'string') {
      return undefined;
    }
    return { createdAt, expiresAt, detail };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    return undefined;
  }
}

async function removeLock(lockPath: string): Promise<void> {
  try {
    await fs.unlink(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

function isExpired(metadata: LockMetadata, now: number): boolean {
  const expiresAt = Date.parse(metadata.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: AcquireLockOptions = {}
): Promise<T> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const detail = options.detail;
  const now = Date.now();
  const expiresAt = new Date(now + ttlMs).toISOString();
  const createdAt = new Date(now).toISOString();
  const metadata: LockMetadata = { createdAt, expiresAt, detail };

  for (;;) {
    try {
      await writeLockFile(lockPath, metadata);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      const existing = await readLockMetadata(lockPath);
      if (!existing || isExpired(existing, Date.now())) {
        await removeLock(lockPath);
        continue;
      }
      throw new LockUnavailableError(
        `Lock at ${lockPath} is held until ${existing.expiresAt}${
          existing.detail ? ` (${existing.detail})` : ''
        }.`
      );
    }
  }

  try {
    return await fn();
  } finally {
    await removeLock(lockPath);
  }
}
