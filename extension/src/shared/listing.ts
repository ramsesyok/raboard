import { promises as fs } from 'fs';
import type { Dirent } from 'fs';

function toSortedFileNames(entries: Dirent[]): string[] {
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export async function listTail(dir: string, limit: number): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = toSortedFileNames(entries);
  if (limit <= 0) {
    return [];
  }
  return files.slice(-limit);
}

export async function listSince(dir: string, lastName: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return toSortedFileNames(entries).filter((name) => name > lastName);
}
