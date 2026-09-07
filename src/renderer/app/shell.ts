/**
 * Empty shell frame (M00): title bar, ribbon tab strip (no groups yet), left/right panes,
 * document area with an empty state, status bar. M02 replaces this file with the real shell.
 */

import { formatShortcut, type Registry } from '@core/Registry';
import { bind, type Store } from '@core/Store';
import { createThemeSwitcher } from '@modules/M01-theme-system/switcher';
import { THEME_SERVICE } from '@modules/M01-theme-system/manifest';
import type { ThemeManager } from '@theme/ThemeManager';

export interface ShellState {
  readonly documentTitle: string | null;
  readonly statusMessage: string;
  readonly theme: string;
}

const RIBBON_TABS = [
  'File',
  'Home',
  'Edit',
  'Comment',
  'View',
  'Form',
  'Protect',
  'Organize',
  'Convert',
  'Accessibility',
  'Help',
] as const;

export function mountShell(root: HTMLElement, registry: Registry, shell: Store<ShellState>): void {
  root.replaceChildren();

  const title = el('header', 'titlebar');
  const h1 = el('h1');
  h1.textContent = 'ynotPDF';
  const docName = el('span', 'doc-title');
  docName.id = 'doc-title';
  title.append(h1, docName);

  const ribbon = el('nav', 'ribbon');
  ribbon.setAttribute('role', 'tablist');
  ribbon.setAttribute('aria-label', 'Ribbon');
  RIBBON_TABS.forEach((name, i) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', i === 1 ? 'true' : 'false');
    tab.textContent = name;
    tab.addEventListener('click', () => {
      for (const t of ribbon.querySelectorAll('[role="tab"]'))
        t.setAttribute('aria-selected', 'false');
      tab.setAttribute('aria-selected', 'true');
    });
    ribbon.append(tab);
  });

  const left = el('aside', 'pane pane-left');
  left.id = 'pane-left';
  const leftTitle = el('h2');
  leftTitle.textContent = 'Navigation';
  left.append(leftTitle);

  const right = el('aside', 'pane pane-right');
  right.id = 'pane-right';
  const rightTitle = el('h2');
  rightTitle.textContent = 'Properties';
  right.append(rightTitle);

  const doc = el('main', 'doc-area');
  doc.id = 'doc-area';
  const empty = el('div', 'empty-state');
  empty.id = 'empty-state';
  const p1 = el('p');
  p1.textContent = 'No document open.';
  const p2 = el('p');
  p2.append('Open a PDF with ');
  const isMac = registry.service<{ isMac: boolean }>('platform').isMac;
  p2.append(kbd(formatShortcut(registry.shortcutFor('file.open') ?? 'Mod+O', isMac)));
  p2.append(' or the command palette ');
  p2.append(
    kbd(formatShortcut(registry.shortcutFor('app.commandPalette') ?? 'Mod+Shift+P', isMac)),
  );
  p2.append('.');
  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'btn btn-primary';
  openBtn.textContent = 'Open PDF';
  openBtn.addEventListener('click', () => {
    void registry.run('file.open');
  });
  empty.append(p1, p2, openBtn);
  doc.append(empty);

  const status = el('footer', 'statusbar');
  status.id = 'statusbar';
  const statusMsg = el('span');
  statusMsg.id = 'status-message';
  statusMsg.setAttribute('role', 'status');
  status.append(statusMsg);
  // M01 puts a live theme switcher here; without the service (unit tests) the status bar is
  // simply one item shorter.
  if (registry.hasService(THEME_SERVICE)) {
    status.append(
      createThemeSwitcher(registry, registry.service<ThemeManager>(THEME_SERVICE)).element,
    );
  }

  root.append(title, ribbon, left, doc, right, status);

  bind(
    shell,
    (s) => s.documentTitle,
    docName,
    'textContent',
    (t) => (t ? `— ${t}` : ''),
  );
  bind(shell, (s) => s.statusMessage, statusMsg, 'textContent');
  shell.select(
    (s) => s.documentTitle,
    (t) => {
      document.title = t ? `${t} — ynotPDF` : 'ynotPDF';
    },
  );
}

function el(tag: string, className?: string): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

function kbd(text: string): HTMLElement {
  const k = document.createElement('kbd');
  k.textContent = text;
  return k;
}
