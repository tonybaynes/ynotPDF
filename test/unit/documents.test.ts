import { describe, expect, it, vi } from 'vitest';
import { Documents, type DocumentTab } from '@app/tabs/Documents';

describe('Documents (tabs)', () => {
  it('opens, activates and de-duplicates by path', () => {
    const d = new Documents();
    const a = d.open({ title: 'A.pdf', path: '/a.pdf' });
    const b = d.open({ title: 'B.pdf', path: '/b.pdf' });
    expect(d.tabs.map((t) => t.id)).toEqual([a.id, b.id]);
    expect(d.active?.id).toBe(b.id);
    const again = d.open({ title: 'A again', path: '/a.pdf' });
    expect(again.id).toBe(a.id);
    expect(d.tabs).toHaveLength(2);
    expect(d.active?.id).toBe(a.id);
    d.open({ title: 'C', activate: false });
    expect(d.active?.id).toBe(a.id);
  });

  it('cycles with wrap-around and moves tabs', () => {
    const d = new Documents();
    const a = d.open({ title: 'A' });
    const b = d.open({ title: 'B' });
    const c = d.open({ title: 'C' });
    expect(d.next()?.id).toBe(a.id);
    expect(d.previous()?.id).toBe(c.id);
    d.move(c.id, 0);
    expect(d.tabs.map((t) => t.id)).toEqual([c.id, a.id, b.id]);
    d.move(c.id, 99);
    expect(d.tabs.map((t) => t.id)).toEqual([a.id, b.id, c.id]);
    d.move('nope', 0);
    expect(d.tabs).toHaveLength(3);
  });

  it('closes through hooks and picks a neighbour as the new active tab', async () => {
    const d = new Documents();
    const a = d.open({ title: 'A' });
    const b = d.open({ title: 'B' });
    const c = d.open({ title: 'C' });
    d.activate(b.id);
    const hook = vi.fn((tab: { dirty: boolean }): Promise<'cancel' | 'close'> =>
      Promise.resolve(tab.dirty ? 'cancel' : 'close'),
    );
    d.onBeforeClose(hook);
    d.setDirty(b.id, true);
    expect(await d.close(b.id)).toBe(false);
    expect(d.tabs).toHaveLength(3);
    d.setDirty(b.id, false);
    const closed = vi.fn();
    d.onClosed(closed);
    expect(await d.close(b.id)).toBe(true);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(d.tabs.map((t) => t.id)).toEqual([a.id, c.id]);
    expect(d.active?.id).toBe(c.id);
    expect(await d.close('nope')).toBe(false);
  });

  it('asks the default hook after the module hooks, and force skips both (M21)', async () => {
    const d = new Documents();
    // Shaped like the shell's own default hook: it only objects to a tab that is still dirty.
    const def = vi.fn((tab: DocumentTab) => (tab.dirty ? ('cancel' as const) : ('close' as const)));
    d.setDefaultCloseHook(def);
    const a = d.open({ title: 'A', dirty: true });
    expect(await d.close(a.id)).toBe(false);
    expect(def).toHaveBeenCalledTimes(1);

    // A module hook that says "close" does not disarm the shell's own question: the default is
    // a backstop, so a dirty tab the module had nothing to say about is still protected.
    const off = d.onBeforeClose(() => 'close');
    expect(await d.close(a.id)).toBe(false);
    expect(def).toHaveBeenCalledTimes(2);

    // A module hook that cancels stops there; the default is never reached.
    const offCancel = d.onBeforeClose(() => 'cancel');
    expect(await d.close(a.id)).toBe(false);
    expect(def).toHaveBeenCalledTimes(2);
    offCancel();

    // The default sees the tab as it is now, so a hook that cleared the flag ends the questions.
    const offClear = d.onBeforeClose((tab) => {
      d.setDirty(tab.id, false);
      return 'close';
    });
    expect(await d.close(a.id)).toBe(true);
    expect(def).toHaveBeenCalledTimes(3);
    offClear();
    off();

    const b = d.open({ title: 'B', dirty: true });
    expect(await d.close(b.id, { force: true })).toBe(true);
    expect(def).toHaveBeenCalledTimes(3);
  });

  it('closes others / all and stops at the first cancel', async () => {
    const d = new Documents();
    const a = d.open({ title: 'A' });
    const b = d.open({ title: 'B' });
    const c = d.open({ title: 'C' });
    d.onBeforeClose((t) => (t.id === b.id ? 'cancel' : 'close'));
    // b refuses, so the loop stops there and c is never asked.
    expect(await d.closeOthers(a.id)).toBe(false);
    expect(d.tabs.map((t) => t.id)).toEqual([a.id, b.id, c.id]);
    expect(await d.closeAll()).toBe(false);
    expect(d.tabs.map((t) => t.id)).toEqual([b.id, c.id]);
  });

  it('keeps attachments per tab and drops them on close', async () => {
    const d = new Documents();
    const a = d.open({ title: 'A' });
    d.attach(a.id, { viewport: 1 });
    expect(d.attachment<{ viewport: number }>(a.id)?.viewport).toBe(1);
    await d.close(a.id);
    expect(d.attachment(a.id)).toBeUndefined();
    expect(d.get(a.id)).toBeNull();
  });
});
