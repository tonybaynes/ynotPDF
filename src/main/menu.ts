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
        {
          label: 'New',
          submenu: [
            cmd('create.blank', 'Blank document…', 'CmdOrCtrl+N'),
            cmd('create.fromImages', 'From images…'),
            cmd('create.fromFiles', 'From files…'),
            cmd('create.fromWebPage', 'From web page…'),
            cmd('create.fromClipboard', 'From clipboard…'),
          ],
        },
        { type: 'separator' },
        cmd('file.open', 'Open…', 'CmdOrCtrl+O'),
        { label: 'Open Recent', submenu: recentItems },
        { type: 'separator' },
        cmd('file.save', 'Save', 'CmdOrCtrl+S'),
        cmd('file.saveAs', 'Save As…', 'Shift+CmdOrCtrl+S'),
        { type: 'separator' },
        cmd('file.close', 'Close', 'CmdOrCtrl+W'),
        { type: 'separator' },
        cmd('file.print', 'Print…', 'CmdOrCtrl+P'),
        cmd('file.printToPdf', 'Print to PDF…'),
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
        // M13's copy and select-all: they act on the *document* selection, and fall back to the
        // focused text field so Ctrl+C still works inside the find bar.
        cmd('edit.copy', 'Copy', 'CmdOrCtrl+C'),
        cmd('edit.copyFormatted', 'Copy with Formatting', 'Shift+CmdOrCtrl+C'),
        { role: 'paste' },
        cmd('edit.selectAll', 'Select All', 'CmdOrCtrl+A'),
        { type: 'separator' },
        cmd('edit.find', 'Find…', 'CmdOrCtrl+F'),
        cmd('edit.findNext', 'Find Next', 'F3'),
        cmd('edit.findPrevious', 'Find Previous', 'Shift+F3'),
        cmd('edit.search', 'Advanced Search…', 'Shift+CmdOrCtrl+F'),
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
  // macOS keeps its menu — it lives in the system bar and the platform expects one. Windows and
  // Linux draw it inside the window, a second row of File/Edit/View above the ribbon's own tabs;
  // the operator wants one tab row, so there is no application menu there (2026-09-10). Nothing
  // is lost: every item's command is in the ribbon or the palette, and all 17 accelerators are
  // also declared by the renderer's own commands, which bind them itself.
  Menu.setApplicationMenu(isMac ? Menu.buildFromTemplate(template) : null);
}
