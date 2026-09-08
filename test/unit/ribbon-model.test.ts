import { describe, expect, it } from 'vitest';
import { Registry } from '@core/Registry';
import { defineModule } from '@shared/module';
import {
  BUILT_IN_TABS,
  buildRibbon,
  groupSignature,
  groupsFor,
  itemState,
  normalizeItem,
  ribbonSignature,
} from '@app/ribbon/model';

function registryWith(inkMode: () => boolean, enabled: () => boolean = () => true): Registry {
  const r = new Registry();
  r.register(
    defineModule({
      id: 'M1',
      name: 'One',
      commands: [
        { id: 'a', label: 'Alpha', category: 'Edit', icon: 'star', keyTip: 'AL', run: () => 1 },
        { id: 'b', label: 'Beta', category: 'Edit', when: enabled, run: () => 2 },
        { id: 'c', label: 'Gamma', category: 'Edit', run: () => 3 },
      ],
      ribbonTabs: [{ id: 'ink', label: 'Ink Tools', when: inkMode }],
      ribbon: [
        {
          id: 'g1',
          tab: 'home',
          label: 'Group one',
          order: 2,
          items: ['a', '-', 'b', { kind: 'toggle', command: 'c', pressed: () => true }],
          large: ['a'],
        },
        { id: 'g0', tab: 'home', label: 'Group zero', order: 1, items: ['c'] },
        { id: 'gink', tab: 'ink', label: 'Ink', items: ['a'] },
        { id: 'ghidden', tab: 'view', label: 'Hidden', when: () => false, items: ['a'] },
        { id: 'gseps', tab: 'view', label: 'Seps', items: ['-', 'a', '-', '-', 'b', '-'] },
        {
          id: 'gwhen',
          tab: 'comment',
          label: 'When',
          items: [
            { kind: 'dropdown', id: 'dd', label: 'Drop', menu: ['a'], when: () => false },
            '-',
            { kind: 'input', id: 'in', label: 'In', command: 'a', value: () => 'v' },
          ],
        },
      ],
    }),
  );
  return r;
}

describe('ribbon model', () => {
  it('lists the ten built-in tabs in Foxit order', () => {
    expect(BUILT_IN_TABS.map((t) => t.id)).toEqual(
      [
        'file',
        'home',
        'edit',
        'comment',
        'view',
        'form',
        'protect',
        'organize',
        'accessibility',
        'help',
        'convert',
      ].sort(
        (a, b) =>
          BUILT_IN_TABS.findIndex((t) => t.id === a) - BUILT_IN_TABS.findIndex((t) => t.id === b),
      ),
    );
    expect(BUILT_IN_TABS[0]?.id).toBe('file');
    expect(BUILT_IN_TABS[1]?.id).toBe('home');
    expect(BUILT_IN_TABS[BUILT_IN_TABS.length - 1]?.id).toBe('help');
    expect(BUILT_IN_TABS).toHaveLength(11);
  });

  it('normalises string items using the command spec and the large list', () => {
    const r = registryWith(() => false);
    const group = r.ribbonGroups().find((g) => g.id === 'g1');
    if (!group) throw new Error('no group');
    const a = normalizeItem('a', group, r);
    expect(a).toMatchObject({
      kind: 'button',
      id: 'a',
      command: 'a',
      label: 'Alpha',
      icon: 'star',
      size: 'large',
      keyTip: 'AL',
    });
    const b = normalizeItem('b', group, r);
    expect(b.size).toBe('small');
    expect(normalizeItem('-', group, r).kind).toBe('separator');
    const unknown = normalizeItem('nope', group, r);
    expect(unknown.label).toBe('nope');
  });

  it('normalises object items with their own id/label/size', () => {
    const r = registryWith(() => false);
    const group = r.ribbonGroups().find((g) => g.id === 'gwhen');
    if (!group) throw new Error('no group');
    const dd = normalizeItem({ kind: 'dropdown', id: 'dd', label: 'Drop', menu: [] }, group, r);
    expect(dd).toMatchObject({
      kind: 'dropdown',
      id: 'dd',
      label: 'Drop',
      command: undefined,
      size: 'small',
    });
    const split = normalizeItem({ kind: 'split', command: 'a', menu: [], size: 'large' }, group, r);
    expect(split).toMatchObject({ kind: 'split', id: 'a', label: 'Alpha', size: 'large' });
  });

  it('sorts groups by order and drops hidden groups and stray separators', () => {
    const r = registryWith(() => false);
    const home = groupsFor('home', r);
    expect(home.map((g) => g.id)).toEqual(['g0', 'g1']);
    const view = groupsFor('view', r);
    expect(view.map((g) => g.id)).toEqual(['gseps']);
    expect(view[0]?.items.map((i) => i.kind)).toEqual(['button', 'separator', 'button']);
  });

  it('filters items by their own when() and cleans separators around them', () => {
    const r = registryWith(() => false);
    const comment = groupsFor('comment', r);
    expect(comment[0]?.items.map((i) => i.id)).toEqual(['in']);
  });

  it('shows contextual tabs only while their when() holds', () => {
    let ink = false;
    const r = registryWith(() => ink);
    let tabs = buildRibbon(r);
    expect(tabs.map((t) => t.id)).not.toContain('ink');
    ink = true;
    tabs = buildRibbon(r);
    const inkTab = tabs.find((t) => t.id === 'ink');
    expect(inkTab).toMatchObject({ contextual: true, label: 'Ink Tools' });
    expect(inkTab?.groups.map((g) => g.id)).toEqual(['gink']);
    expect(ribbonSignature(buildRibbon(r))).not.toBe(
      ribbonSignature(buildRibbon(registryWith(() => false))),
    );
  });

  it('computes item state and a group signature that changes with it', () => {
    let enabled = true;
    const r = registryWith(
      () => false,
      () => enabled,
    );
    const g1 = groupsFor('home', r).find((g) => g.id === 'g1');
    if (!g1) throw new Error('no g1');
    const toggle = g1.items.find((i) => i.kind === 'toggle');
    if (!toggle) throw new Error('no toggle');
    expect(itemState(toggle, r)).toEqual({
      enabled: true,
      pressed: true,
      value: null,
      label: null,
    });
    const before = groupSignature(g1, r);
    enabled = false;
    const after = groupSignature(g1, r);
    expect(after).not.toBe(before);
    expect(itemState(g1.items[2] ?? toggle, r).enabled).toBe(false);
  });

  it('survives a when() that throws by treating it as false', () => {
    const r = new Registry();
    r.register(
      defineModule({
        id: 'M1',
        name: 'One',
        commands: [{ id: 'a', label: 'A', category: 'Edit', run: () => 1 }],
        ribbonTabs: [
          {
            id: 'boom',
            label: 'Boom',
            when: () => {
              throw new Error('boom');
            },
          },
        ],
        ribbon: [{ id: 'g', tab: 'boom', label: 'G', items: ['a'] }],
      }),
    );
    expect(buildRibbon(r).map((t) => t.id)).not.toContain('boom');
  });
});
