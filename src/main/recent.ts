/**
 * Recent-files store (M00) backed by `electron-store` (JSON in the OS user-data dir).
 * Schema-versioned so later modules can migrate it.
 */

import Store from 'electron-store';
import { basename } from 'node:path';
import type { RecentFile } from '../shared/ipc';

interface RecentSchema {
  version: number;
  recent: RecentFile[];
}

const MAX_RECENT = 10;

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
    return this.store.get('recent');
  }

  add(path: string): RecentFile[] {
    const entry: RecentFile = { path, name: basename(path), openedAt: Date.now() };
    const next = [entry, ...this.list().filter((r) => r.path !== path)].slice(0, MAX_RECENT);
    this.store.set('recent', next);
    return next;
  }

  remove(path: string): RecentFile[] {
    const next = this.list().filter((r) => r.path !== path);
    this.store.set('recent', next);
    return next;
  }

  clear(): RecentFile[] {
    this.store.set('recent', []);
    return [];
  }
}
