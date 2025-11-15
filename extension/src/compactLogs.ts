import { promises as fs } from 'fs';
import type { Dirent } from 'fs';
import * as vscode from 'vscode';
import type { RaBoardConfig } from './config';
import { wjoin } from './config';
import { withFileLock, LockUnavailableError } from './shared/lock';

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const LOCK_TTL_MS = 15 * 60 * 1000;

const PRESET_LAST_WEEK = '先週まで';
const PRESET_EXCLUDE_TODAY = '当日を除く全期間';
const PRESET_UNTIL_DATE = '日付指定（～指定日まで）';

type PresetChoice =
  | typeof PRESET_LAST_WEEK
  | typeof PRESET_EXCLUDE_TODAY
  | typeof PRESET_UNTIL_DATE;

interface CompactSummary {
  considered: number;
  appended: number;
  skipped: number;
  days: string[];
}

interface ResolvedScope {
  cutoffMs: number;
  label: string;
}

function toSortedFileNames(entries: Dirent[]): string[] {
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function startOfJstDayMs(date: Date): number {
  const jstDate = new Date(date.getTime() + JST_OFFSET_MS);
  const year = jstDate.getUTCFullYear();
  const month = jstDate.getUTCMonth();
  const day = jstDate.getUTCDate();
  return Date.UTC(year, month, day) - JST_OFFSET_MS;
}

function startOfJstWeekMs(date: Date): number {
  const jstDate = new Date(date.getTime() + JST_OFFSET_MS);
  const dayOfWeek = jstDate.getUTCDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  const year = jstDate.getUTCFullYear();
  const month = jstDate.getUTCMonth();
  const day = jstDate.getUTCDate();
  const startOfDay = Date.UTC(year, month, day) - JST_OFFSET_MS;
  return startOfDay - daysSinceMonday * DAY_MS;
}

function jstDateKey(timestamp: number): string {
  const jstDate = new Date(timestamp + JST_OFFSET_MS);
  const year = jstDate.getUTCFullYear();
  const month = (jstDate.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = jstDate.getUTCDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function computeCutoffForDateInput(input: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return undefined;
  }
  const [yearStr, monthStr, dayStr] = input.split('-');
  const year = Number.parseInt(yearStr, 10);
  const month = Number.parseInt(monthStr, 10) - 1;
  const day = Number.parseInt(dayStr, 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return undefined;
  }
  if (month < 0 || month > 11 || day < 1 || day > 31) {
    return undefined;
  }
  const base = new Date(Date.UTC(year, month, day));
  if (base.getUTCFullYear() !== year || base.getUTCMonth() !== month || base.getUTCDate() !== day) {
    return undefined;
  }
  const nextDayUtc = Date.UTC(year, month, day + 1);
  return nextDayUtc - JST_OFFSET_MS;
}

async function pickRoom(
  config: RaBoardConfig,
  output: vscode.OutputChannel
): Promise<string | undefined> {
  const roomsRoot = wjoin(config.shareRoot, 'rooms');
  let rooms: string[] = [];
  try {
    const entries = await fs.readdir(roomsRoot, { withFileTypes: true });
    rooms = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    output.appendLine(`Failed to enumerate rooms under ${roomsRoot}: ${detail}`);
    void vscode.window.showErrorMessage(`Failed to enumerate rooms under ${roomsRoot}: ${detail}`);
    return undefined;
  }

  if (rooms.length === 0) {
    void vscode.window.showInformationMessage('No rooms are available to compact.');
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    rooms.sort((a, b) => a.localeCompare(b)),
    {
      placeHolder: 'Select a room to compact logs for',
      canPickMany: false,
    }
  );
  return picked ?? undefined;
}

async function pickPreset(): Promise<PresetChoice | undefined> {
  const presets: PresetChoice[] = [PRESET_LAST_WEEK, PRESET_EXCLUDE_TODAY, PRESET_UNTIL_DATE];
  const picked = await vscode.window.showQuickPick(presets, {
    placeHolder: 'Choose compaction range',
    canPickMany: false,
    activeItem: PRESET_LAST_WEEK,
  });
  return picked ?? undefined;
}

async function resolveScope(choice: PresetChoice): Promise<ResolvedScope | undefined> {
  const now = new Date();
  if (choice === PRESET_LAST_WEEK) {
    const cutoffMs = startOfJstWeekMs(now);
    return { cutoffMs, label: PRESET_LAST_WEEK };
  }
  if (choice === PRESET_EXCLUDE_TODAY) {
    const cutoffMs = startOfJstDayMs(now);
    return { cutoffMs, label: PRESET_EXCLUDE_TODAY };
  }
  const input = await vscode.window.showInputBox({
    prompt: 'Enter the cutoff date (YYYY-MM-DD)',
    placeHolder: '2024-01-31',
    validateInput: (value) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
        return 'Please enter a date in YYYY-MM-DD format.';
      }
      return undefined;
    },
  });
  const trimmed = input?.trim();
  if (!trimmed) {
    return undefined;
  }
  const cutoffMs = computeCutoffForDateInput(trimmed);
  if (cutoffMs === undefined) {
    void vscode.window.showErrorMessage('Invalid date specified.');
    return undefined;
  }
  return { cutoffMs, label: `${PRESET_UNTIL_DATE} ${trimmed}` };
}

async function processSpool(
  spoolDir: string,
  logsDir: string,
  cutoffMs: number,
  output: vscode.OutputChannel
): Promise<CompactSummary> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(spoolDir, { withFileTypes: true });
  } catch (error) {
    output.appendLine(`Failed to list spool files under ${spoolDir}: ${String(error)}`);
    throw error;
  }

  const files = toSortedFileNames(entries);
  await fs.mkdir(logsDir, { recursive: true });
  const daysTouched = new Set<string>();
  let considered = 0;
  let appended = 0;
  let skipped = 0;

  for (const name of files) {
    const filePath = wjoin(spoolDir, name);
    let payload: string;
    try {
      payload = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      output.appendLine(`Failed to read ${filePath}: ${String(error)}`);
      skipped++;
      continue;
    }

    if (payload.length === 0) {
      skipped++;
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch (error) {
      output.appendLine(`Invalid JSON in ${filePath}: ${String(error)}`);
      skipped++;
      continue;
    }

    if (!parsed || typeof parsed !== 'object') {
      skipped++;
      continue;
    }

    const tsValue = (parsed as { ts?: unknown }).ts;
    if (typeof tsValue !== 'string') {
      skipped++;
      continue;
    }

    const timestamp = Date.parse(tsValue);
    if (!Number.isFinite(timestamp) || timestamp >= cutoffMs) {
      continue;
    }

    considered++;
    const dayKey = jstDateKey(timestamp);
    const line = payload.endsWith('\n') ? payload : `${payload}\n`;
    const dayPath = wjoin(logsDir, `${dayKey}.ndjson`);
    try {
      await fs.appendFile(dayPath, line, { encoding: 'utf8' });
    } catch (error) {
      output.appendLine(`Failed to append ${filePath} to ${dayKey}.ndjson: ${String(error)}`);
      skipped++;
      continue;
    }

    try {
      await fs.unlink(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        output.appendLine(`Failed to delete ${filePath}: ${String(error)}`);
        skipped++;
        continue;
      }
    }

    appended++;
    daysTouched.add(dayKey);
  }

  return { considered, appended, skipped, days: Array.from(daysTouched.values()).sort() };
}

function formatSummary(room: string, scope: ResolvedScope, summary: CompactSummary): string {
  const { considered, appended, skipped, days } = summary;
  const daySummary = days.length > 0 ? days.join(', ') : 'none';
  return `Compacted logs for "${room}" (${scope.label}): considered ${considered}, appended ${appended}, skipped ${skipped}, days touched: ${daySummary}.`;
}

export async function runCompactLogs(
  config: RaBoardConfig,
  output: vscode.OutputChannel
): Promise<void> {
  const room = await pickRoom(config, output);
  if (!room) {
    return;
  }

  const preset = await pickPreset();
  if (!preset) {
    return;
  }

  const scope = await resolveScope(preset);
  if (!scope) {
    return;
  }

  const spoolDir = wjoin(config.shareRoot, 'rooms', room, 'msgs');
  const logsDir = wjoin(config.shareRoot, 'rooms', room, 'logs');
  const lockPath = wjoin(logsDir, '.lock');

  try {
    const summary = await withFileLock(
      lockPath,
      async () => processSpool(spoolDir, logsDir, scope.cutoffMs, output),
      { ttlMs: LOCK_TTL_MS, detail: `Compacting ${room}` }
    );
    const message = formatSummary(room, scope, summary);
    output.appendLine(message);
    void vscode.window.showInformationMessage(message);
  } catch (error) {
    if (error instanceof LockUnavailableError) {
      void vscode.window.showWarningMessage(error.message);
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    output.appendLine(`Compaction failed for "${room}": ${detail}`);
    void vscode.window.showErrorMessage(`Failed to compact logs for "${room}": ${detail}`);
  }
}
