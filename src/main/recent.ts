/**
 * Recent-files store (M00) backed by `electron-store` (JSON in the OS user-data dir).
 * Schema-versioned so later modules can migrate it.
 *
 * M02 adds pinning: pinned entries sort first, never fall off the end of the list, and survive
 * `clear()` (Foxit's backstage behaves the same way).
 */

import Store from 'electron-store';
import { basename } from 'node:path';
import type { RecentFile } from '../shared/ipc';

interface RecentSchema {
  version: number;
  recent: RecentFile[];
}

const MAX_RECENT = 10;

function sorted(list: RecentFile[]): RecentFile[] {
  return [...list].sort(
    (a, b) => Number(b.pinned === true) - Number(a.pinned === true) || b.openedAt - a.openedAt,
  );
}

export class RecentFiles {
  private readonly store: Store<RecentSchema>;

  constructor(cwd?: string) {
    this.store = new Store<RecentSchema>({
      name: 'recent-files',
      ...(cwd !== undefined ? { cwd } : {}),
      defaults: { version: 1, recent: [] },
    });
  }

  list(): RecentFile[] {
    return sorted(this.store.get('recent'));
  }

  add(path: string): RecentFile[] {
    const existing = this.list().find((r) => r.path === path);
    const entry: RecentFile = {
      path,
      name: basename(path),
      openedAt: Date.now(),
      ...(existing?.pinned === true ? { pinned: true } : {}),
    };
    const rest = this.list().filter((r) => r.path !== path);
    const pinned = rest.filter((r) => r.pinned === true);
    const unpinned = rest.filter((r) => r.pinned !== true);
    const next = entry.pinned
      ? [entry, ...pinned, ...unpinned]
      : [...pinned, entry, ...unpinned].slice(0, Math.max(MAX_RECENT, pinned.length + 1));
    return this.save(next);
  }

  /** Pins or unpins an entry; unknown paths are ignored. */
  pin(path: string, pinned: boolean): RecentFile[] {
    const next = this.list().map((r) => {
      if (r.path !== path) return r;
      const { pinned: _old, ...rest } = r;
      return pinned ? { ...rest, pinned: true } : rest;
    });
    return this.save(next);
  }

  remove(path: string): RecentFile[] {
    return this.save(this.list().filter((r) => r.path !== path));
  }

  /** Clears everything except pinned entries. */
  clear(): RecentFile[] {
    return this.save(this.list().filter((r) => r.pinned === true));
  }

  private save(next: RecentFile[]): RecentFile[] {
    const list = sorted(next);
    this.store.set('recent', list);
    return list;
  }
}
