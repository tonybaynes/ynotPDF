/**
 * Demo module (M02) — registered ONLY in e2e runs. It exercises every shell contribution point
 * (each ribbon widget kind, a contextual tab, left and right panels, status-bar items, a
 * backstage page, creators, context menus, tools) and is the regression suite for the shell.
 * Never delete anything from it; later modules add to the real app, this stays as the fixture.
 */

import { createStore } from '@core/Store';
import type { Selection } from '@core/Selection';
import { defineModule, type ServiceContext } from '@shared/module';
import type { Dialogs } from '@app/dialog/Dialogs';
import type { Toasts } from '@app/dialog/toast';
import type { Documents } from '@app/tabs/Documents';
import type { UiStore } from '@app/ui/UiState';

interface DemoState {
  readonly bold: boolean;
  readonly shape: string;
  readonly colour: string;
  readonly size: string;
  readonly font: string;
  readonly inkMode: boolean;
  readonly counter: number;
  readonly lastCommand: string;
  readonly lastArgs: Readonly<Record<string, unknown>>;
}

export const demoState = createStore<DemoState>({
  bold: false,
  shape: 'rectangle',
  colour: 'var(--annot-highlight)',
  size: '12',
  font: 'sans',
  inkMode: false,
  counter: 0,
  lastCommand: '',
  lastArgs: {},
});

const docs = (ctx: ServiceContext): Documents => ctx.service<Documents>('documents');
const ui = (ctx: ServiceContext): UiStore => ctx.service<UiStore>('ui');

function record(id: string, args: Readonly<Record<string, unknown>>): void {
  demoState.set({ lastCommand: id, lastArgs: args, counter: demoState.get().counter + 1 });
}

let demoCounter = 0;

export default defineModule({
  id: 'M999',
  name: 'Demo (e2e only)',
  commands: [
    {
      id: 'demo.hello',
      label: 'Demo: Hello',
      category: 'Developer',
      icon: 'sparkles',
      description: 'Says hello (e2e demo)',
      run: (ctx) => {
        record('demo.hello', ctx.args);
        return 'hello';
      },
    },
    {
      id: 'demo.small',
      label: 'Demo: Small button',
      category: 'Developer',
      icon: 'star',
      run: (ctx) => {
        record('demo.small', ctx.args);
        return 'small';
      },
    },
    {
      id: 'demo.disabled',
      label: 'Demo: Always disabled',
      category: 'Developer',
      icon: 'lock',
      when: () => false,
      run: () => 'never',
    },
    {
      id: 'demo.bold',
      label: 'Demo: Bold',
      category: 'Developer',
      icon: 'type',
      shortcut: 'Mod+Alt+B',
      run: (ctx) => {
        demoState.set((s) => ({ bold: !s.bold }));
        record('demo.bold', ctx.args);
        ctx.service<{ invalidate(): void }>('shellServices').invalidate();
        return demoState.get().bold;
      },
    },
    {
      id: 'demo.split.main',
      label: 'Demo: Split main',
      category: 'Developer',
      icon: 'scissors',
      run: (ctx) => {
        record('demo.split.main', ctx.args);
        return 'main';
      },
    },
    {
      id: 'demo.split.a',
      label: 'Demo: Split option A',
      category: 'Developer',
      run: (ctx) => {
        record('demo.split.a', ctx.args);
        return 'a';
      },
    },
    {
      id: 'demo.split.b',
      label: 'Demo: Split option B',
      category: 'Developer',
      run: (ctx) => {
        record('demo.split.b', ctx.args);
        return 'b';
      },
    },
    {
      id: 'demo.menu.one',
      label: 'Demo: Menu one',
      category: 'Developer',
      icon: 'circle',
      run: (ctx) => {
        record('demo.menu.one', ctx.args);
        return 1;
      },
    },
    {
      id: 'demo.menu.two',
      label: 'Demo: Menu two',
      category: 'Developer',
      icon: 'triangle',
      run: (ctx) => {
        record('demo.menu.two', ctx.args);
        return 2;
      },
    },
    {
      id: 'demo.menu.sub',
      label: 'Demo: Submenu item',
      category: 'Developer',
      run: (ctx) => {
        record('demo.menu.sub', ctx.args);
        return 'sub';
      },
    },
    {
      id: 'demo.shape',
      label: 'Demo: Shape…',
      category: 'Developer',
      icon: 'square',
      run: (ctx) => {
        const v = typeof ctx.args['value'] === 'string' ? ctx.args['value'] : '';
        demoState.set({ shape: v });
        record('demo.shape', ctx.args);
        ctx.service<{ invalidate(): void }>('shellServices').invalidate();
        return v;
      },
    },
    {
      id: 'demo.colour',
      label: 'Demo: Colour…',
      category: 'Developer',
      icon: 'droplet',
      run: (ctx) => {
        const v = typeof ctx.args['value'] === 'string' ? ctx.args['value'] : '';
        demoState.set({ colour: v });
        record('demo.colour', ctx.args);
        ctx.service<{ invalidate(): void }>('shellServices').invalidate();
        return v;
      },
    },
    {
      id: 'demo.size',
      label: 'Demo: Size…',
      category: 'Developer',
      icon: 'ruler',
      run: (ctx) => {
        const v = typeof ctx.args['value'] === 'string' ? ctx.args['value'] : '';
        demoState.set({ size: v });
        record('demo.size', ctx.args);
        ctx.service<{ invalidate(): void }>('shellServices').invalidate();
        return v;
      },
    },
    {
      id: 'demo.font',
      label: 'Demo: Font…',
      category: 'Developer',
      icon: 'baseline',
      run: (ctx) => {
        const v = typeof ctx.args['value'] === 'string' ? ctx.args['value'] : '';
        demoState.set({ font: v });
        record('demo.font', ctx.args);
        ctx.service<{ invalidate(): void }>('shellServices').invalidate();
        return v;
      },
    },
    {
      id: 'demo.ink.toggle',
      label: 'Demo: Ink mode',
      category: 'Developer',
      icon: 'pen-tool',
      description: 'Flips the predicate behind the contextual "Ink Tools" tab',
      run: (ctx) => {
        demoState.set((s) => ({ inkMode: !s.inkMode }));
        record('demo.ink.toggle', ctx.args);
        ctx.service<{ invalidate(): void }>('shellServices').invalidate();
        return demoState.get().inkMode;
      },
    },
    {
      id: 'demo.ink.thin',
      label: 'Demo: Thin ink',
      category: 'Developer',
      icon: 'pencil',
      run: (ctx) => {
        record('demo.ink.thin', ctx.args);
        return 'thin';
      },
    },
    {
      id: 'demo.ink.thick',
      label: 'Demo: Thick ink',
      category: 'Developer',
      icon: 'highlighter',
      run: (ctx) => {
        record('demo.ink.thick', ctx.args);
        return 'thick';
      },
    },
    {
      id: 'demo.openDocument',
      label: 'Demo: Open demo document',
      category: 'Developer',
      icon: 'file-plus',
      description: 'Opens a fake document tab (pass { title?, dirty?, path? })',
      run: (ctx) => {
        demoCounter++;
        const title =
          typeof ctx.args['title'] === 'string' ? ctx.args['title'] : `Demo ${demoCounter}.pdf`;
        const tab = docs(ctx).open({
          title,
          path: typeof ctx.args['path'] === 'string' ? ctx.args['path'] : null,
          dirty: ctx.args['dirty'] === true,
        });
        void ctx.run('view.setPageCount', {
          count: typeof ctx.args['pages'] === 'number' ? ctx.args['pages'] : 12,
        });
        return tab.id;
      },
    },
    {
      id: 'demo.markDirty',
      label: 'Demo: Mark document modified',
      category: 'Developer',
      icon: 'square-pen',
      run: (ctx) => {
        const id = typeof ctx.args['id'] === 'string' ? ctx.args['id'] : docs(ctx).active?.id;
        if (!id) return false;
        docs(ctx).setDirty(id, ctx.args['dirty'] !== false);
        return true;
      },
    },
    {
      id: 'demo.selectText',
      label: 'Demo: Select text',
      category: 'Developer',
      icon: 'text-cursor-input',
      description: 'Makes a fake text selection so the Text panel appears in the properties pane',
      run: (ctx) => {
        ctx.service<Selection>('selection').set({
          kind: 'text',
          ranges: [{ page: 0, startRun: 0, startChar: 0, endRun: 0, endChar: 5 }],
        });
        return 'text';
      },
    },
    {
      id: 'demo.selectNone',
      label: 'Demo: Clear selection',
      category: 'Developer',
      icon: 'x',
      run: (ctx) => {
        ctx.service<Selection>('selection').clear();
        return 'none';
      },
    },
    {
      id: 'demo.progress',
      label: 'Demo: Progress dialog',
      category: 'Developer',
      icon: 'loader',
      description: 'Opens a cancellable progress dialog that finishes after { ms } (default 400)',
      run: async (ctx) => {
        const dialogs = ctx.service<Dialogs>('dialogs');
        const ms = typeof ctx.args['ms'] === 'number' ? ctx.args['ms'] : 400;
        const p = dialogs.progress({
          title: 'Demo progress',
          text: 'Working…',
          id: 'demo-progress',
        });
        for (let i = 0; i <= 10; i++) {
          if (p.cancelled) break;
          p.set(i / 10, `Step ${i} of 10`);
          await new Promise((r) => setTimeout(r, ms / 10));
        }
        const cancelled = p.cancelled;
        p.close();
        return cancelled ? 'cancelled' : 'done';
      },
    },
    {
      id: 'demo.form',
      label: 'Demo: Form dialog',
      category: 'Developer',
      icon: 'list',
      description: 'A dialog built with the form helpers; resolves with the values',
      run: async (ctx) => {
        const dialogs = ctx.service<Dialogs>('dialogs');
        const { field, formGrid } = await import('@app/dialog/Dialogs');
        const name = document.createElement('input');
        name.type = 'text';
        name.id = 'demo-form-name';
        const size = document.createElement('input');
        size.type = 'number';
        size.id = 'demo-form-size';
        size.value = '12';
        const h = dialogs.open({
          id: 'demo-form',
          title: 'Demo form',
          content: formGrid(
            field({ label: 'Name', input: name, hint: 'Shown in the title', required: true }),
            field({ label: 'Size', input: size, hint: 'Points' }),
          ),
          initialFocus: name,
          buttons: [
            {
              id: 'ok',
              label: 'Apply',
              primary: true,
              onPress: () => name.value.trim().length > 0,
            },
            { id: 'cancel', label: 'Cancel' },
          ],
        });
        const r = await h.result;
        return { result: r, name: name.value, size: size.value };
      },
    },
    {
      id: 'demo.toast',
      label: 'Demo: Toast',
      category: 'Developer',
      icon: 'bell',
      run: (ctx) => {
        ctx.service<Toasts>('toasts').show({
          kind: 'success',
          text: 'Demo toast',
          id: 'demo-toast',
          actions: [
            {
              label: 'Undo',
              run: () => {
                record('demo.toast.undo', {});
              },
            },
          ],
        });
        return true;
      },
    },
    {
      id: 'demo.state',
      label: 'Demo: state',
      category: 'Developer',
      hidden: true,
      run: () => demoState.get(),
    },
    {
      id: 'demo.nonModal',
      label: 'Demo: Non-modal dialog',
      category: 'Developer',
      icon: 'app-window',
      run: (ctx) => {
        const h = ctx.service<Dialogs>('dialogs').open({
          id: 'demo-nonmodal',
          title: 'Non-modal',
          modal: false,
          content: (body) => {
            body.textContent = 'You can still use the app behind this.';
          },
          buttons: [{ id: 'close', label: 'Close', primary: true }],
        });
        return h.isOpen;
      },
    },
    {
      id: 'demo.create.blank',
      label: 'Demo: Create blank',
      category: 'Developer',
      icon: 'file-plus',
      run: (ctx) => {
        const tab = docs(ctx).open({ title: 'Untitled.pdf', dirty: true });
        void ctx.run('view.setPageCount', { count: 1 });
        return tab.id;
      },
    },
    {
      id: 'demo.ui',
      label: 'Demo: ui state',
      category: 'Developer',
      hidden: true,
      run: (ctx) => ui(ctx).get(),
    },
  ],
  ribbonTabs: [
    { id: 'demo.ink', label: 'Ink Tools', when: () => demoState.get().inkMode, order: 10 },
  ],
  ribbon: [
    {
      id: 'demo.buttons',
      tab: 'home',
      label: 'Demo buttons',
      order: 1,
      items: [
        'demo.hello',
        'demo.small',
        'demo.disabled',
        '-',
        { kind: 'toggle', command: 'demo.bold', pressed: () => demoState.get().bold },
      ],
      large: ['demo.hello'],
    },
    {
      id: 'demo.menus',
      tab: 'home',
      label: 'Demo menus',
      order: 2,
      items: [
        {
          kind: 'split',
          command: 'demo.split.main',
          menu: ['demo.split.a', 'demo.split.b'],
          size: 'large',
        },
        {
          kind: 'dropdown',
          id: 'demo.dropdown',
          label: 'Options',
          icon: 'menu',
          menu: [
            'demo.menu.one',
            '-',
            { label: 'Bold', command: 'demo.bold', checked: () => demoState.get().bold },
            { label: 'More', submenu: ['demo.menu.sub', 'demo.menu.two'] },
          ],
        },
      ],
    },
    {
      id: 'demo.pickers',
      tab: 'home',
      label: 'Demo pickers',
      order: 3,
      items: [
        {
          kind: 'gallery',
          id: 'demo.gallery',
          label: 'Shape',
          icon: 'square',
          command: 'demo.shape',
          options: [
            { value: 'rectangle', label: 'Rectangle', icon: 'square' },
            { value: 'circle', label: 'Circle', icon: 'circle' },
            { value: 'triangle', label: 'Triangle', icon: 'triangle' },
            { value: 'star', label: 'Star', icon: 'star' },
          ],
          selected: () => demoState.get().shape,
          size: 'large',
        },
        {
          kind: 'color',
          id: 'demo.color',
          label: 'Colour',
          icon: 'paint-bucket',
          command: 'demo.colour',
          value: () => demoState.get().colour,
          swatches: [
            { value: 'var(--annot-highlight)', label: 'Highlight' },
            { value: 'var(--annot-ink)', label: 'Ink' },
            { value: 'var(--annot-shape)', label: 'Shape' },
            { value: 'var(--annot-note)', label: 'Note' },
          ],
        },
        {
          kind: 'input',
          id: 'demo.sizeInput',
          label: 'Size',
          command: 'demo.size',
          type: 'number',
          value: () => demoState.get().size,
          min: 1,
          max: 99,
          width: 5,
        },
        {
          kind: 'input',
          id: 'demo.fontSelect',
          label: 'Font',
          command: 'demo.font',
          type: 'select',
          value: () => demoState.get().font,
          options: [
            { value: 'sans', label: 'Sans' },
            { value: 'serif', label: 'Serif' },
            { value: 'mono', label: 'Mono' },
          ],
        },
      ],
    },
    {
      id: 'demo.wide1',
      tab: 'organize',
      label: 'Demo wide one',
      order: 50,
      items: ['demo.hello', 'demo.small', 'demo.hello', 'demo.small'].map((c, i) => ({
        kind: 'button' as const,
        command: c,
        size: i % 2 ? 'small' : 'large',
      })),
    },
    {
      id: 'demo.wide2',
      tab: 'organize',
      label: 'Demo wide two',
      order: 51,
      items: [
        'demo.hello',
        'demo.small',
        'demo.hello',
        'demo.small',
        'demo.hello',
        'demo.small',
      ].map((c) => ({ kind: 'button' as const, command: c, size: 'large' as const })),
    },
    {
      id: 'demo.wide3',
      tab: 'organize',
      label: 'Demo wide three',
      order: 52,
      items: [
        'demo.hello',
        'demo.small',
        'demo.hello',
        'demo.small',
        'demo.hello',
        'demo.small',
      ].map((c) => ({ kind: 'button' as const, command: c, size: 'large' as const })),
    },
    {
      id: 'demo.ink.tools',
      tab: 'demo.ink',
      label: 'Ink',
      order: 1,
      items: ['demo.ink.thin', 'demo.ink.thick'],
      large: ['demo.ink.thin', 'demo.ink.thick'],
    },
    {
      id: 'demo.comment',
      tab: 'comment',
      label: 'Demo comment',
      order: 1,
      items: ['demo.ink.toggle', 'demo.selectText', 'demo.selectNone'],
      large: ['demo.ink.toggle'],
    },
    {
      id: 'demo.dialogs',
      tab: 'help',
      label: 'Demo dialogs',
      order: 1,
      items: [
        'demo.progress',
        'demo.form',
        'demo.toast',
        'demo.nonModal',
        'demo.openDocument',
        'demo.markDirty',
      ],
    },
  ],
  panels: [
    {
      id: 'demo.alpha',
      title: 'Demo Alpha',
      dock: 'left',
      icon: 'layers',
      order: 1,
      mount: (host) => {
        host.append(
          Object.assign(document.createElement('p'), {
            textContent: 'Alpha panel content',
            id: 'demo-panel-alpha',
          }),
        );
        const input = document.createElement('input');
        input.type = 'text';
        input.setAttribute('aria-label', 'Alpha input');
        host.append(input);
        return () => undefined;
      },
    },
    {
      id: 'demo.beta',
      title: 'Demo Beta',
      dock: 'left',
      icon: 'bookmark',
      order: 2,
      mount: (host) => {
        host.append(
          Object.assign(document.createElement('p'), {
            textContent: 'Beta panel content',
            id: 'demo-panel-beta',
          }),
        );
        return () => undefined;
      },
    },
    {
      id: 'demo.textProps',
      title: 'Text properties',
      dock: 'right',
      icon: 'type',
      order: 1,
      when: (ctx) => ctx.service<Selection>('selection').kind === 'text',
      mount: (host) => {
        host.append(
          Object.assign(document.createElement('p'), {
            textContent: 'Text selection properties',
            id: 'demo-props-text',
          }),
        );
        return () => undefined;
      },
    },
    {
      id: 'demo.docProps',
      title: 'Document properties',
      dock: 'right',
      icon: 'file-text',
      order: 2,
      when: (ctx) => ctx.service<Documents>('documents').tabs.length > 0,
      mount: (host) => {
        host.append(
          Object.assign(document.createElement('p'), {
            textContent: 'Document properties',
            id: 'demo-props-doc',
          }),
        );
        return () => undefined;
      },
    },
  ],
  tools: [
    {
      id: 'tool.demoInk',
      label: 'Demo ink tool',
      icon: 'pen-tool',
      activate: () => {
        demoState.set({ inkMode: true });
      },
      deactivate: () => {
        demoState.set({ inkMode: false });
      },
    },
  ],
  statusBar: [
    {
      id: 'demo.status',
      slot: 'right',
      order: 1,
      mount: (host) => {
        const span = document.createElement('span');
        span.id = 'demo-status';
        const unsub = demoState.select(
          (s) => s.counter,
          (n) => {
            span.textContent = `Demo: ${String(n)}`;
          },
        );
        host.append(span);
        return unsub;
      },
    },
  ],
  backstage: [
    {
      slot: 'properties',
      mount: (host) => {
        host.append(
          Object.assign(document.createElement('h2'), {
            textContent: 'Demo properties page',
            id: 'demo-backstage-props',
          }),
        );
        return () => undefined;
      },
    },
    { slot: 'print', command: 'demo.hello', label: 'Print (demo)' },
  ],
  creators: [
    {
      id: 'demo.blank',
      label: 'Blank (demo)',
      description: 'A blank demo document',
      icon: 'file',
      command: 'demo.create.blank',
    },
  ],
  contextMenus: [
    { id: 'demo.ctx.document', region: 'document', order: 50, items: ['demo.hello'] },
    {
      id: 'demo.ctx.any',
      region: 'any',
      order: 90,
      items: [{ label: 'Demo anywhere', command: 'demo.small' }],
    },
  ],
});
