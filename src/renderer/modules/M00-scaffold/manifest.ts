/**
 * M00 manifest: application-level commands that exist before any feature module.
 * Every user action here is a palette entry with a shortcut where sensible.
 */

import { openPalette } from '@app/palette';
import { showAbout, showMessage } from '@app/dialogs';
import type { ShellState } from '@app/shell';
import type { Documents } from '@app/tabs/Documents';
import type { Registry } from '@core/Registry';
import type { EngineClient } from '@engine/EngineClient';
import type { Store } from '@core/Store';
import { defineModule } from '@shared/module';
import { hasBridge, invoke, type AppInfo, type OpenedFile } from '@shared/ipc';

const FILE_ARG = 'file';

export default defineModule({
  id: 'M00',
  name: 'Scaffold',
  commands: [
    {
      id: 'file.open',
      label: 'Open…',
      category: 'File',
      icon: 'folder-open',
      shortcut: 'Mod+O',
      description: 'Open a PDF from disk',
      run: async (ctx) => {
        if (!hasBridge()) {
          await showMessage('Open', 'File dialogs need the Electron shell.');
          return null;
        }
        const file = await invoke('file:openDialog');
        if (!file) return null;
        return ctx.run('file.openBytes', { [FILE_ARG]: file });
      },
    },
    {
      id: 'file.openRecent',
      label: 'Open Recent…',
      category: 'File',
      icon: 'history',
      description: 'Open a recently used file (pass { path })',
      run: async (ctx) => {
        const path = ctx.args['path'];
        if (typeof path !== 'string') {
          const recent = hasBridge() ? await invoke('recent:list') : [];
          return recent;
        }
        const file = await invoke('file:read', path);
        return ctx.run('file.openBytes', { [FILE_ARG]: file });
      },
    },
    {
      id: 'file.openBytes',
      label: 'Open bytes',
      category: 'File',
      hidden: true,
      description: 'Internal: load an already-read file into the shell',
      run: (ctx) => {
        const file = ctx.args[FILE_ARG] as OpenedFile | undefined;
        if (!file) throw new Error('file.openBytes needs { file }');
        const shell = ctx.service<Store<ShellState>>('shell');
        const registry = ctx.service<Registry>('registry');
        // M10/M11 turn this into a real Document + viewer; until then the shell (M02) opens a
        // tab for it and M00 only reflects the name.
        if (registry.hasService('documents')) {
          registry.service<Documents>('documents').open({ title: file.name, path: file.path });
        } else {
          shell.set({ documentTitle: file.name });
        }
        shell.set({
          statusMessage: `Loaded ${file.name} (${file.bytes.byteLength.toLocaleString('en-GB')} bytes) — rendering arrives with M10/M11`,
        });
        return { name: file.name, size: file.bytes.byteLength };
      },
    },
    {
      id: 'file.close',
      label: 'Close',
      category: 'File',
      icon: 'x',
      shortcut: 'Mod+W',
      when: (ctx) => {
        const registry = ctx.service<Registry>('registry');
        if (registry.hasService('documents'))
          return registry.service<Documents>('documents').tabs.length > 0;
        return ctx.service<Store<ShellState>>('shell').get().documentTitle !== null;
      },
      run: async (ctx) => {
        const registry = ctx.service<Registry>('registry');
        const shell = ctx.service<Store<ShellState>>('shell');
        if (registry.hasService('documents')) {
          const docs = registry.service<Documents>('documents');
          const id = typeof ctx.args['id'] === 'string' ? ctx.args['id'] : docs.active?.id;
          if (!id) return false;
          const closed = await docs.close(id);
          if (closed && docs.tabs.length === 0) shell.set({ statusMessage: 'Ready' });
          return closed;
        }
        shell.set({ documentTitle: null, statusMessage: 'Ready' });
        return true;
      },
    },
    // `edit.undo` and `edit.redo` were stubbed here by M00 and are now registered by M20, which
    // owns the undo stack and can also say what each of them would revert.
    {
      id: 'app.commandPalette',
      label: 'Command Palette',
      category: 'Application',
      icon: 'terminal',
      shortcut: 'Mod+Shift+P',
      description: 'Search and run any command',
      run: (ctx) => {
        openPalette(ctx.service<Registry>('registry'));
      },
    },
    {
      id: 'app.about',
      label: 'About ynotPDF',
      category: 'Help',
      icon: 'info',
      run: async () => {
        const info: AppInfo | null = hasBridge() ? await invoke('app:info') : null;
        const dialog = showAbout(info);
        return { open: dialog.open };
      },
    },
    {
      id: 'app.quit',
      label: 'Quit',
      category: 'Application',
      icon: 'power',
      shortcut: 'Mod+Q',
      run: async () => {
        if (hasBridge()) await invoke('app:quit');
        else window.close();
      },
    },
    {
      id: 'dev.toggleDevTools',
      label: 'Toggle Developer Tools',
      category: 'Developer',
      icon: 'bug',
      shortcut: 'F12',
      run: async () => {
        if (hasBridge()) await invoke('devtools:toggle');
      },
    },
    {
      id: 'dev.engineInfo',
      label: 'Engine information',
      category: 'Developer',
      icon: 'cpu',
      description: 'Name and version of the PDF engine running in the worker',
      run: async (ctx) => {
        const client = ctx.service<EngineClient>('engineClient');
        await client.ready();
        return client.engine.info();
      },
    },
  ],
});
