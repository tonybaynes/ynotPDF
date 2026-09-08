/**
 * Changed-on-disk watcher (M21), chokidar (MIT) in the main process.
 *
 * One watch per open document path, per window. When the file changes underneath us the window
 * is told, and the renderer asks the reader what to do about it — Reload or Keep mine.
 *
 * Two details make the difference between useful and infuriating:
 *
 * - **Our own saves are not news.** `suspend(path)` mutes a path while we write to it and
 *   unmutes it a moment after; without that, every save would announce itself.
 * - **A change is reported once it has settled.** Editors and sync clients write a file in
 *   several goes, and `awaitWriteFinish` waits for the size to stop moving before saying
 *   anything, so one save elsewhere produces one prompt rather than four.
 */

import { watch, type FSWatcher } from 'chokidar';

/** How long a file must stop changing before the change counts as finished. */
const SETTLE_MS = 400;
/** How long after our own write the path stays muted, to cover the filesystem's own lag. */
const SELF_WRITE_QUIET_MS = 1500;

export type WatchListener = (path: string) => void;

interface Entry {
  readonly watcher: FSWatcher;
  readonly owners: Set<number>;
}

/**
 * Watches document paths and reports changes. Owner ids are the caller's own (window ids); a
 * path stops being watched when its last owner lets go.
 */
export class FileWatchers {
  private readonly entries = new Map<string, Entry>();
  private readonly mutedUntil = new Map<string, number>();
  private readonly listener: WatchListener;

  constructor(listener: WatchListener) {
    this.listener = listener;
  }

  /** Paths currently watched (diagnostics and tests). */
  get watched(): string[] {
    return [...this.entries.keys()].sort();
  }

  watch(path: string, owner: number): void {
    const existing = this.entries.get(path);
    if (existing) {
      existing.owners.add(owner);
      return;
    }
    const watcher = watch(path, {
      ignoreInitial: true,
      // The path is a file we already have open; following symlinks costs nothing and following
      // a directory is not something we ever want.
      depth: 0,
      awaitWriteFinish: { stabilityThreshold: SETTLE_MS, pollInterval: 100 },
    });
    const report = (): void => {
      if (this.isMuted(path)) return;
      this.listener(path);
    };
    watcher.on('change', report);
    watcher.on('unlink', report);
    // A watcher that cannot start (the file was on a share that went away) must not take the
    // app down with it; the document simply stops being watched.
    watcher.on('error', () => undefined);
    this.entries.set(path, { watcher, owners: new Set([owner]) });
  }

  unwatch(path: string, owner: number): void {
    const entry = this.entries.get(path);
    if (!entry) return;
    entry.owners.delete(owner);
    if (entry.owners.size > 0) return;
    this.entries.delete(path);
    void entry.watcher.close().catch(() => undefined);
  }

  /** Drops every watch a window held (the window closed). */
  release(owner: number): void {
    for (const path of [...this.entries.keys()]) this.unwatch(path, owner);
  }

  /** Mutes a path while we write to it. Call before the write; it un-mutes itself. */
  suspend(path: string, forMs = SELF_WRITE_QUIET_MS): void {
    this.mutedUntil.set(path, Date.now() + forMs);
  }

  /** Ends the mute early (the write failed, so a later change really is someone else's). */
  resume(path: string): void {
    this.mutedUntil.delete(path);
  }

  private isMuted(path: string): boolean {
    const until = this.mutedUntil.get(path);
    if (until === undefined) return false;
    if (Date.now() <= until) return true;
    this.mutedUntil.delete(path);
    return false;
  }

  async closeAll(): Promise<void> {
    const watchers = [...this.entries.values()].map((e) => e.watcher);
    this.entries.clear();
    this.mutedUntil.clear();
    await Promise.all(watchers.map((w) => w.close().catch(() => undefined)));
  }
}
