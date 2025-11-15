import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { promises as fsp } from 'fs';
import type { Dirent, Stats } from 'fs';

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: () => undefined,
    }),
  },
}));

let spool: typeof import('../../../extension/src/shared/spool');
let presence: typeof import('../../../extension/src/shared/presence');

beforeAll(async () => {
  spool = await import('../../../extension/src/shared/spool');
  presence = await import('../../../extension/src/shared/presence');
});

function createDirent(name: string): Dirent {
  return {
    name,
    isFile: () => true,
  } as unknown as Dirent;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('heartbeat', () => {
  it('writes sanitized presence entry with timestamp', async () => {
    const writeSpy = vi.spyOn(spool, 'writeJsonAtomic').mockResolvedValue();
    const now = new Date('2024-01-01T12:00:00.000Z');

    await presence.heartbeat('\\\\mysv01\\board', 'Alice Example', { now });

    expect(writeSpy).toHaveBeenCalledWith('\\\\mysv01\\board\\presence', 'Alice_Example.json', {
      user: 'Alice Example',
      ts: now.toISOString(),
    });
  });

  it('rejects when no usable user characters remain', async () => {
    await expect(
      presence.heartbeat('\\\\mysv01\\board', '   ', { now: new Date() })
    ).rejects.toThrow('Presence user name must contain at least one valid character.');
  });

  it('wraps missing presence directory errors', async () => {
    const enoent = Object.assign(new Error('missing'), { code: 'ENOENT' });
    vi.spyOn(spool, 'writeJsonAtomic').mockRejectedValue(enoent);

    await expect(
      presence.heartbeat('\\\\mysv01\\board', 'Alice', { now: new Date() })
    ).rejects.toBeInstanceOf(presence.PresenceUnavailableError);
  });
});

describe('scanPresence', () => {
  it('returns active users sorted and filters stale entries', async () => {
    const now = new Date('2024-01-01T00:01:00.000Z');
    vi.spyOn(fsp, 'readdir').mockResolvedValue([
      createDirent('alice.json'),
      createDirent('bob.json'),
      createDirent('charlie.json'),
    ]);

    vi.spyOn(fsp, 'stat').mockImplementation(async (file) => {
      if (typeof file === 'string' && file.includes('alice')) {
        return { mtime: new Date('2024-01-01T00:00:45.000Z') } as unknown as Stats;
      }

      if (typeof file === 'string' && file.includes('bob')) {
        return { mtime: new Date('2023-12-31T23:59:00.000Z') } as unknown as Stats;
      }

      return { mtime: new Date('2024-01-01T00:00:30.000Z') } as unknown as Stats;
    });

    const errors: string[] = [];
    vi.spyOn(fsp, 'readFile').mockImplementation(async (file) => {
      if (typeof file === 'string' && file.includes('alice')) {
        return JSON.stringify({ user: 'Alice Example', ts: now.toISOString() });
      }

      if (typeof file === 'string' && file.includes('charlie')) {
        throw new Error('invalid json');
      }

      return JSON.stringify({ user: 'Bob Example', ts: now.toISOString() });
    });

    const users = await presence.scanPresence('\\\\mysv01\\board', 60, {
      now,
      onError: (message) => errors.push(message),
    });

    expect(users).toEqual(['Alice Example', 'charlie']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('charlie.json');
  });

  it('throws PresenceUnavailableError when directory missing', async () => {
    const enoent = Object.assign(new Error('missing'), { code: 'ENOENT' });
    vi.spyOn(fsp, 'readdir').mockRejectedValue(enoent);

    await expect(presence.scanPresence('\\\\mysv01\\board', 60)).rejects.toBeInstanceOf(
      presence.PresenceUnavailableError
    );
  });
});

it('exposes scheduler intervals', () => {
  expect(presence.HEARTBEAT_INTERVAL_MS).toBe(30_000);
  expect(presence.PRESENCE_SCAN_INTERVAL_MS).toBe(5_000);
});
