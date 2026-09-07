import { describe, expect, it, vi } from 'vitest';
import { CommandNotFoundError, keyFromEvent, normalizeKey, Registry } from '@core/Registry';
import { defineModule } from '@shared/module';

describe('Registry', () => {
  it('registers commands and runs them with args', async () => {
    const r = new Registry();
    const run = vi.fn((ctx: { args: Record<string, unknown> }) => ctx.args['x']);
    r.register(
      defineModule({
        id: 'M1',
        name: 'One',
        commands: [{ id: 'a.b', label: 'B', category: 'Edit', run }],
      }),
    );
    expect(r.has('a.b')).toBe(true);
    expect(await r.run('a.b', { x: 42 })).toBe(42);
    await expect(r.run('nope')).rejects.toBeInstanceOf(CommandNotFoundError);
  });

  it('rejects duplicate module and command ids', () => {
    const r = new Registry();
    const m = defineModule({
      id: 'M1',
      name: 'One',
      commands: [{ id: 'a', label: 'A', category: 'Edit', run: () => 1 }],
    });
    r.register(m);
    expect(() => {
      r.register(m);
    }).toThrow(/already registered/);
    expect(() => {
      r.register(
        defineModule({
          id: 'M2',
          name: 'Two',
          commands: [{ id: 'a', label: 'A', category: 'Edit', run: () => 1 }],
        }),
      );
    }).toThrow(/Command a/);
  });

  it('honours when clauses for isEnabled, run and palette entries', async () => {
    const r = new Registry();
    let enabled = false;
    r.register(
      defineModule({
        id: 'M1',
        name: 'One',
        commands: [
          { id: 'x', label: 'X', category: 'View', when: () => enabled, run: () => 'ran' },
          { id: 'h', label: 'Hidden', category: 'View', hidden: true, run: () => 'h' },
        ],
      }),
    );
    expect(r.isEnabled('x')).toBe(false);
    expect(r.paletteEntries().map((e) => e.id)).toEqual([]);
    await expect(r.run('x')).rejects.toThrow(/not available/);
    enabled = true;
    expect(r.paletteEntries().map((e) => e.id)).toEqual(['x']);
    expect(await r.run('x')).toBe('ran');
    expect(await r.run('h')).toBe('h');
  });

  it('binds shortcuts from commands and manifest, normalised', () => {
    const r = new Registry();
    r.register(
      defineModule({
        id: 'M1',
        name: 'One',
        commands: [
          { id: 'open', label: 'Open', category: 'File', shortcut: 'mod+o', run: () => 1 },
        ],
        shortcuts: [{ key: 'shift+Mod+p', command: 'open', scope: 'global' }],
      }),
    );
    expect(r.shortcutForKey('Mod+O')?.command).toBe('open');
    expect(r.shortcutForKey('Mod+Shift+P')?.scope).toBe('global');
    expect(r.shortcutFor('open')).toBe('Mod+O');
    expect(r.allShortcuts()).toHaveLength(2);
    expect(r.paletteEntries()[0]?.shortcut).toBe('Mod+O');
  });

  it('provides services and exposes them through the context', async () => {
    const r = new Registry();
    r.provide('greeter', { hi: () => 'hello' });
    r.register(
      defineModule({
        id: 'M1',
        name: 'One',
        commands: [
          {
            id: 'g',
            label: 'G',
            category: 'Edit',
            run: (ctx) => ctx.service<{ hi(): string }>('greeter').hi(),
          },
        ],
      }),
    );
    expect(await r.run('g')).toBe('hello');
    expect(r.hasService('greeter')).toBe(true);
    expect(() => r.service('missing')).toThrow(/Unknown service/);
  });

  it('auto-generates activate/toggle commands for tools and panels and sorts ribbon groups', () => {
    const r = new Registry();
    const tools = { activate: vi.fn() };
    const panels = { toggle: vi.fn() };
    r.provide('tools', tools);
    r.provide('panels', panels);
    r.register(
      defineModule({
        id: 'M1',
        name: 'One',
        tools: [{ id: 'tool.hand', label: 'Hand' }],
        panels: [
          {
            id: 'nav.thumbs',
            title: 'Thumbnails',
            dock: 'left',
            order: 2,
            mount: () => () => undefined,
          },
        ],
        ribbon: [
          { id: 'b', tab: 'home', label: 'B', order: 5, items: ['x'] },
          { id: 'a', tab: 'home', label: 'A', order: 5, items: ['y'] },
          { id: 'c', tab: 'view', label: 'C', order: 1, items: [] },
        ],
      }),
    );
    expect(r.has('tool.hand.activate')).toBe(true);
    expect(r.has('panel.nav.thumbs')).toBe(true);
    expect(r.ribbonGroups().map((g) => g.id)).toEqual(['c', 'a', 'b']);
    expect(r.panels()).toHaveLength(1);
    expect(r.tools()).toHaveLength(1);
    expect(r.modules()).toHaveLength(1);
    return Promise.all([r.run('tool.hand.activate'), r.run('panel.nav.thumbs')]).then(() => {
      expect(tools.activate).toHaveBeenCalledWith('tool.hand');
      expect(panels.toggle).toHaveBeenCalledWith('nav.thumbs');
    });
  });

  it('calls activate on activateAll and on late registration, and disposes', () => {
    const r = new Registry();
    const dispose = vi.fn();
    const activate = vi.fn(() => dispose);
    r.register(defineModule({ id: 'M1', name: 'One', activate }));
    expect(activate).not.toHaveBeenCalled();
    r.activateAll();
    r.activateAll();
    expect(activate).toHaveBeenCalledTimes(1);
    const late = vi.fn(() => undefined);
    r.register(defineModule({ id: 'M2', name: 'Two', activate: late }));
    expect(late).toHaveBeenCalledTimes(1);
    r.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('notifies subscribers on registration', () => {
    const r = new Registry();
    const l = vi.fn();
    const off = r.subscribe(l);
    r.register(defineModule({ id: 'M1', name: 'One' }));
    expect(l).toHaveBeenCalledTimes(1);
    off();
    r.register(defineModule({ id: 'M2', name: 'Two' }));
    expect(l).toHaveBeenCalledTimes(1);
  });
});

describe('normalizeKey / keyFromEvent', () => {
  it('normalises modifier order and aliases', () => {
    expect(normalizeKey('shift+ctrl+a')).toBe('Ctrl+Shift+A');
    expect(normalizeKey('CmdOrCtrl+P')).toBe('Mod+P');
    expect(normalizeKey('cmd+alt+ArrowLeft')).toBe('Alt+Meta+ArrowLeft');
    expect(normalizeKey('F11')).toBe('F11');
  });

  it('maps keyboard events to Mod on each platform', () => {
    const ev = (init: Partial<KeyboardEvent>): KeyboardEvent =>
      ({
        key: 'p',
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        ...init,
      }) as KeyboardEvent;
    expect(keyFromEvent(ev({ ctrlKey: true, shiftKey: true }), false)).toBe('Mod+Shift+P');
    expect(keyFromEvent(ev({ metaKey: true, shiftKey: true }), true)).toBe('Mod+Shift+P');
    expect(keyFromEvent(ev({ metaKey: true }), false)).toBe('Meta+P');
    expect(keyFromEvent(ev({ ctrlKey: true, metaKey: true }), true)).toBe('Mod+Ctrl+P');
    expect(keyFromEvent(ev({ key: ' ', altKey: true }), false)).toBe('Alt+Space');
    expect(keyFromEvent(ev({ key: 'Shift' }), false)).toBeNull();
  });
});
