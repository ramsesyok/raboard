import { promises as fs } from 'fs';
import * as vscode from 'vscode';
import type { RaBoardConfig } from './config';
import { wjoin } from './config';
import { REQUIRED_ROOM_SUBDIRS } from './readiness';
import { listSince, listTail } from './shared/listing';

export interface UnreadSummaryRoom {
  readonly room: string;
  readonly count: number;
}

export interface UnreadSummary {
  readonly total: number;
  readonly rooms: readonly UnreadSummaryRoom[];
  readonly showBadge: boolean;
}

interface NotificationMonitorOptions {
  readonly getConfig: () => RaBoardConfig | undefined;
  readonly getActiveRoom: () => string | undefined;
  readonly getLastSeenMessageName: (room: string) => string | undefined;
  readonly onFocusRoom: (room: string) => Promise<void>;
  readonly onSummary: (summary: UnreadSummary | undefined) => Promise<void>;
  readonly output: vscode.OutputChannel;
}

interface RoomDelta {
  readonly room: string;
  readonly count: number;
  readonly increment: number;
}

function uniqueRooms(rooms: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const room of rooms) {
    const trimmed = room.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function shouldShowBadge(config: RaBoardConfig): boolean {
  return config.notifications.mode === 'badge' || config.notifications.mode === 'both';
}

function shouldShowStatus(config: RaBoardConfig): boolean {
  return config.notifications.mode === 'status' || config.notifications.mode === 'both';
}

function shouldShowToast(config: RaBoardConfig): boolean {
  if (config.notifications.dnd) {
    return false;
  }
  return config.notifications.mode === 'toast' || config.notifications.mode === 'both';
}

function toThrottleMs(config: RaBoardConfig): number {
  const minimum = 1000;
  return Math.max(minimum, config.notifications.throttleMs);
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export class NotificationMonitor implements vscode.Disposable {
  private readonly unreadCounts = new Map<string, number>();
  private readonly latestObserved = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;
  private scanPromise: Promise<void> | undefined;
  private statusBar: vscode.StatusBarItem | undefined;
  private lastToastAt = 0;

  constructor(private readonly options: NotificationMonitorOptions) {}

  public dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.statusBar) {
      this.statusBar.dispose();
      this.statusBar = undefined;
    }
  }

  public start(): void {
    if (this.disposed) {
      return;
    }

    const config = this.options.getConfig();
    if (!config || !config.notifications.enabled) {
      void this.publishIndicators(undefined);
      return;
    }

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    const interval = toThrottleMs(config);
    this.timer = setInterval(() => {
      void this.scan();
    }, interval);

    void this.scan();
  }

  public markRoomRead(room: string): void {
    if (!room) {
      return;
    }
    this.unreadCounts.delete(room);
    const lastSeen = this.options.getLastSeenMessageName(room);
    if (lastSeen) {
      this.latestObserved.set(room, lastSeen);
    } else {
      this.latestObserved.delete(room);
    }
    void this.publishIndicators(this.options.getConfig());
  }

  public async showUnreadQuickPick(): Promise<void> {
    const entries = this.getSortedUnreadEntries();
    if (entries.length === 0) {
      return;
    }

    const items = entries.map((entry) => ({
      label: `#${entry.room}`,
      description: entry.count === 1 ? '1 unread message' : `${entry.count} unread messages`,
      room: entry.room,
    }));

    const selection = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a room to open',
      ignoreFocusOut: true,
    });

    if (selection?.room) {
      try {
        await this.options.onFocusRoom(selection.room);
      } catch (error) {
        this.logError(`Failed to open room "${selection.room}" from quick pick`, error);
      }
    }
  }

  private async scan(): Promise<void> {
    if (this.disposed) {
      return;
    }

    if (this.scanPromise) {
      return this.scanPromise;
    }

    const config = this.options.getConfig();
    if (!config || !config.notifications.enabled) {
      this.unreadCounts.clear();
      this.latestObserved.clear();
      await this.publishIndicators(undefined);
      return;
    }

    const promise = this.doScan(config)
      .catch((error) => {
        this.logError('Failed to scan rooms for notifications', error);
      })
      .finally(() => {
        this.scanPromise = undefined;
      });

    this.scanPromise = promise;
    return promise;
  }

  private async doScan(config: RaBoardConfig): Promise<void> {
    const rooms = await this.resolveTargetRooms(config);
    const tracked = new Set<string>(rooms);
    const increases: RoomDelta[] = [];

    for (const room of rooms) {
      if (!room) {
        continue;
      }

      if (!config.notifications.includeActiveRoom && room === this.options.getActiveRoom()) {
        continue;
      }

      const ready = await this.isRoomReady(config, room);
      if (!ready) {
        this.unreadCounts.delete(room);
        this.latestObserved.delete(room);
        continue;
      }

      const delta = await this.scanRoom(config, room);
      if (delta && delta.increment > 0) {
        increases.push(delta);
      }
    }

    for (const room of Array.from(this.unreadCounts.keys())) {
      if (!tracked.has(room)) {
        this.unreadCounts.delete(room);
        this.latestObserved.delete(room);
      }
    }

    await this.publishIndicators(config);

    if (increases.length > 0 && shouldShowToast(config)) {
      await this.maybeShowToast(config, increases);
    }
  }

  private async scanRoom(config: RaBoardConfig, room: string): Promise<RoomDelta | undefined> {
    const msgsDir = wjoin(config.shareRoot, 'rooms', room, 'msgs');
    const lastSeen = this.options.getLastSeenMessageName(room);
    const observed = this.latestObserved.get(room);
    let baseline = observed;
    if (lastSeen && (!baseline || lastSeen > baseline)) {
      baseline = lastSeen;
    }

    if (!baseline) {
      const latest = await this.readLatestMessageName(msgsDir);
      if (latest) {
        this.latestObserved.set(room, latest);
      }
      return undefined;
    }

    let files: string[] = [];
    try {
      files = await listSince(msgsDir, baseline);
    } catch (error) {
      this.logError(`Failed to enumerate messages for room "${room}"`, error);
      return undefined;
    }

    if (files.length === 0) {
      return undefined;
    }

    const newest = files[files.length - 1];
    this.latestObserved.set(room, newest);

    const previous = this.unreadCounts.get(room) ?? 0;
    const count = previous + files.length;
    this.unreadCounts.set(room, count);

    return { room, count, increment: files.length };
  }

  private async readLatestMessageName(msgsDir: string): Promise<string | undefined> {
    try {
      const tail = await listTail(msgsDir, 1);
      return tail.length > 0 ? tail[tail.length - 1] : undefined;
    } catch (error) {
      this.logError(`Failed to read latest message in ${msgsDir}`, error);
      return undefined;
    }
  }

  private async resolveTargetRooms(config: RaBoardConfig): Promise<string[]> {
    if (config.notifications.rooms.length > 0) {
      return uniqueRooms(config.notifications.rooms);
    }

    const roomsRoot = wjoin(config.shareRoot, 'rooms');
    try {
      const entries = await fs.readdir(roomsRoot, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
      this.logError(`Failed to enumerate rooms under ${roomsRoot}`, error);
      return [];
    }
  }

  private async isRoomReady(config: RaBoardConfig, room: string): Promise<boolean> {
    const roomRoot = wjoin(config.shareRoot, 'rooms', room);
    if (!(await directoryExists(roomRoot))) {
      return false;
    }

    for (const subdir of REQUIRED_ROOM_SUBDIRS) {
      const subdirPath = wjoin(roomRoot, subdir);
      if (!(await directoryExists(subdirPath))) {
        return false;
      }
    }

    return true;
  }

  private getSortedUnreadEntries(): UnreadSummaryRoom[] {
    return Array.from(this.unreadCounts.entries())
      .filter(([, count]) => count > 0)
      .map(([room, count]) => ({ room, count }))
      .sort((a, b) => (b.count === a.count ? (a.room < b.room ? -1 : 1) : b.count - a.count));
  }

  private async publishIndicators(config: RaBoardConfig | undefined): Promise<void> {
    if (!config || !config.notifications.enabled) {
      await this.options.onSummary(undefined);
      this.hideStatusBar();
      return;
    }

    const entries = this.getSortedUnreadEntries();
    const total = entries.reduce((sum, entry) => sum + entry.count, 0);

    if (shouldShowBadge(config)) {
      await this.options.onSummary({
        total,
        rooms: entries,
        showBadge: total > 0,
      });
    } else {
      await this.options.onSummary(undefined);
    }

    if (shouldShowStatus(config)) {
      this.updateStatusBar(total, entries);
    } else {
      this.hideStatusBar();
    }
  }

  private updateStatusBar(total: number, entries: readonly UnreadSummaryRoom[]): void {
    if (total <= 0) {
      this.hideStatusBar();
      return;
    }

    if (!this.statusBar) {
      this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
      this.statusBar.name = 'raBoard notifications';
      this.statusBar.command = 'raBoard.openUnreadRoom';
    }

    const top = entries.slice(0, 3).map((entry) => `#${entry.room} (${entry.count})`);
    const tooltipLines = ['Unread messages:', ...top];
    if (entries.length > top.length) {
      tooltipLines.push(`…and ${entries.length - top.length} more room(s).`);
    }

    this.statusBar.text = `$(bell-dot) ${total}`;
    this.statusBar.tooltip = tooltipLines.join('\n');
    this.statusBar.show();
  }

  private hideStatusBar(): void {
    if (this.statusBar) {
      this.statusBar.hide();
    }
  }

  private async maybeShowToast(config: RaBoardConfig, increases: RoomDelta[]): Promise<void> {
    if (!shouldShowToast(config) || increases.length === 0) {
      return;
    }

    const now = Date.now();
    if (now - this.lastToastAt < toThrottleMs(config)) {
      return;
    }

    this.lastToastAt = now;

    const sorted = [...increases].sort((a, b) =>
      b.count === a.count ? (a.room < b.room ? -1 : 1) : b.count - a.count
    );
    const primary = sorted[0];
    const message =
      sorted.length === 1
        ? `New activity in #${primary.room} (${primary.count} unread).`
        : `New activity in ${sorted.length} rooms. Latest: #${primary.room} (${primary.count} unread).`;
    const action = sorted.length === 1 ? `Open #${primary.room}` : 'Choose room…';

    const choice = await vscode.window.showInformationMessage(message, action);
    if (!choice) {
      return;
    }

    try {
      if (sorted.length === 1) {
        await this.options.onFocusRoom(primary.room);
      } else {
        await this.showUnreadQuickPick();
      }
    } catch (error) {
      this.logError('Failed to open room from notification toast', error);
    }
  }

  private logError(context: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.options.output.appendLine(`${context}: ${detail}`);
  }
}
