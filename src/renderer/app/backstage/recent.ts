/**
 * Recent-files list (M02): shared by the backstage Recent page and the empty state. Reads
 * through `recent:list`, follows `recent:changed` pushes from main, and offers pin / unpin /
 * remove per row (all words, with icons).
 */

import { hasBridge, invoke, on, type RecentFile } from '@shared/ipc';
import { append, button, el, srOnly } from '../dom';
import { icon } from '../icons';
import type { ShellServices } from '../services';

export interface RecentListOptions {
  /** Maximum rows (default all). */
  readonly limit?: number;
  /** Show pin / remove controls (default true). */
  readonly controls?: boolean;
  readonly emptyText?: string;
}

export interface RecentListHandle {
  readonly element: HTMLElement;
  refresh(): Promise<void>;
  dispose(): void;
}

export function formatWhen(ms: number, now = Date.now()): string {
  const diff = now - ms;
  const day = 86_400_000;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < day) return `${Math.round(diff / 3_600_000)} h ago`;
  if (diff < 7 * day) return `${Math.round(diff / day)} d ago`;
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(new Date(ms));
}

export function createRecentList(
  services: ShellServices,
  options: RecentListOptions = {},
): RecentListHandle {
  const list = el('ul.recent-list', { role: 'list' });
  let files: RecentFile[] = [];

  const render = (): void => {
    list.replaceChildren();
    const rows = options.limit ? files.slice(0, options.limit) : files;
    if (rows.length === 0) {
      list.append(el('li.recent-empty', null, options.emptyText ?? 'No recent files yet.'));
      return;
    }
    for (const f of rows) {
      const li = el('li.recent-row', { 'data-path': f.path });
      const open = button('recent-open', { title: f.path });
      append(
        open,
        icon(f.pinned ? 'pin' : 'file-text'),
        el('span.recent-name', null, f.name),
        f.pinned ? srOnly(' (pinned)') : null,
        el('span.recent-meta', null, `${formatWhen(f.openedAt)} · ${f.path}`),
      );
      open.addEventListener('click', () => {
        void services.run('file.openRecent', { path: f.path });
      });
      li.append(open);
      if (options.controls !== false) {
        const pin = button('icon-btn recent-pin', {
          'aria-label': f.pinned ? `Unpin ${f.name}` : `Pin ${f.name}`,
          title: f.pinned ? 'Unpin' : 'Pin to top',
          'aria-pressed': f.pinned ? 'true' : 'false',
        });
        pin.append(icon(f.pinned ? 'pin-off' : 'pin'));
        pin.addEventListener('click', () => {
          void services.run('file.recent.pin', { path: f.path, pinned: !f.pinned });
        });
        const remove = button('icon-btn recent-remove', {
          'aria-label': `Remove ${f.name} from recent files`,
          title: 'Remove from list',
        });
        remove.append(icon('x'));
        remove.addEventListener('click', () => {
          void services.run('file.recent.remove', { path: f.path });
        });
        li.append(pin, remove);
      }
      list.append(li);
    }
  };

  const refresh = async (): Promise<void> => {
    files = hasBridge() ? await invoke('recent:list') : [];
    render();
  };
  const unsub = hasBridge()
    ? on('recent:changed', (next) => {
        files = next;
        render();
      })
    : () => undefined;
  render();
  void refresh();
  return { element: list, refresh, dispose: unsub };
}
