/**
 * Native menu skeleton (M00): File / Edit / View / Window / Help. Items send `menu:command`
 * to the renderer so the same command table drives menus, palette and shortcuts.
 */

import { app, Menu, type MenuItemConstructorOptions } from 'electron';
import type { RecentFiles } from './recent';
import { sendToRenderer } from './window';

const isMac = process.platform === 'darwin';

function cmd(id: string, label: string, accelerator?: string): MenuItemConstructorOptions {
  return {
    label,
    ...(accelerator !== undefined ? { accelerator } : {}),
    click: () => {
      sendToRenderer('menu:command', { id });
    },
  };
}

export function buildMenu(recent: RecentFiles): void {
  const recentItems: MenuItemConstructorOptions[] = recent.list().map((r) => ({
    label: r.name,
    sublabel: r.path,
    click: () => {
      sendToRenderer('menu:command', { id: 'file.openRecent', args: { path: r.path } });
    },
  }));
  if (recentItems.length === 0) recentItems.push({ label: 'No recent files', enabled: false });
  recentItems.push(
    { type: 'separator' },
    {
      label: 'Clear Recent',
      click: () => {
        recent.clear();
        buildMenu(recent);
      },
    },
  );

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.getName(),
            submenu: [
              cmd('app.about', 'About ynotPDF'),
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: '&File',
      submenu: [
        cmd('file.open', 'Open…', 'CmdOrCtrl+O'),
        { label: 'Open Recent', submenu: recentItems },
        { type: 'separator' },
        cmd('file.close', 'Close', 'CmdOrCtrl+W'),
        { type: 'separator' },
        ...(isMac ? [] : [cmd('app.quit', 'Quit', 'CmdOrCtrl+Q')]),
      ],
    },
    {
      label: '&Edit',
      submenu: [
        cmd('edit.undo', 'Undo', 'CmdOrCtrl+Z'),
        cmd('edit.redo', 'Redo', isMac ? 'Shift+CmdOrCtrl+Z' : 'CmdOrCtrl+Y'),
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '&View',
      submenu: [
        cmd('app.commandPalette', 'Command Palette…', 'CmdOrCtrl+Shift+P'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        cmd('dev.toggleDevTools', 'Toggle Developer Tools', 'F12'),
        { role: 'reload' },
      ],
    },
    {
      label: '&Window',
      role: 'window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? [{ type: 'separator' as const }, { role: 'front' as const }]
          : [{ role: 'close' as const }]),
      ],
    },
    {
      label: '&Help',
      role: 'help',
      submenu: [cmd('app.about', 'About ynotPDF')],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
