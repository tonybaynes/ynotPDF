import { describe, expect, it, vi } from 'vitest';
import { bind, createStore, shallowEqual } from '@core/Store';

interface S {
  count: number;
  name: string;
  list: number[];
}

const init = (): S => ({ count: 0, name: 'a', list: [] });

describe('Store', () => {
  it('returns a copy of the initial state', () => {
    const initial = init();
    const s = createStore(initial);
    expect(s.get()).toEqual(initial);
    expect(s.get()).not.toBe(initial);
  });

  it('set merges a patch and notifies with (state, previous)', () => {
    const s = createStore(init());
    const l = vi.fn();
    s.subscribe(l);
    s.set({ count: 1 });
    expect(s.get().count).toBe(1);
    expect(s.get().name).toBe('a');
    expect(l).toHaveBeenCalledTimes(1);
    const [state, previous] = l.mock.calls[0] as [S, S];
    expect(state.count).toBe(1);
    expect(previous.count).toBe(0);
  });

  it('set accepts an updater function', () => {
    const s = createStore(init());
    s.set((st) => ({ count: st.count + 5 }));
    expect(s.get().count).toBe(5);
  });

  it('does not notify when nothing changed', () => {
    const s = createStore(init());
    const l = vi.fn();
    s.subscribe(l);
    s.set({ count: 0 });
    s.set(() => ({}));
    expect(l).not.toHaveBeenCalled();
  });

  it('replace swaps the whole state', () => {
    const s = createStore(init());
    const l = vi.fn();
    s.subscribe(l);
    s.replace({ count: 9, name: 'z', list: [1] });
    expect(s.get()).toEqual({ count: 9, name: 'z', list: [1] });
    expect(l).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops notifications and updates listenerCount', () => {
    const s = createStore(init());
    const l = vi.fn();
    const off = s.subscribe(l);
    expect(s.listenerCount).toBe(1);
    off();
    expect(s.listenerCount).toBe(0);
    s.set({ count: 1 });
    expect(l).not.toHaveBeenCalled();
  });

  describe('select', () => {
    it('fires immediately with the current value, then only on change', () => {
      const s = createStore(init());
      const l = vi.fn();
      s.select((st) => st.count, l);
      expect(l).toHaveBeenCalledWith(0, 0);
      s.set({ name: 'b' });
      expect(l).toHaveBeenCalledTimes(1);
      s.set({ count: 2 });
      expect(l).toHaveBeenCalledTimes(2);
      expect(l).toHaveBeenLastCalledWith(2, 0);
    });

    it('can skip the immediate call', () => {
      const s = createStore(init());
      const l = vi.fn();
      s.select((st) => st.count, l, { immediate: false });
      expect(l).not.toHaveBeenCalled();
      s.set({ count: 1 });
      expect(l).toHaveBeenCalledTimes(1);
    });

    it('supports a custom equality', () => {
      const s = createStore(init());
      const l = vi.fn();
      s.select((st) => st.list, l, { equals: shallowEqual, immediate: false });
      s.set({ list: [] });
      expect(l).not.toHaveBeenCalled();
      s.set({ list: [1] });
      expect(l).toHaveBeenCalledTimes(1);
    });

    it('returns an unsubscribe function', () => {
      const s = createStore(init());
      const l = vi.fn();
      const off = s.select((st) => st.count, l, { immediate: false });
      off();
      s.set({ count: 1 });
      expect(l).not.toHaveBeenCalled();
    });
  });

  describe('batch', () => {
    it('coalesces several sets into one notification with the earliest previous', () => {
      const s = createStore(init());
      const l = vi.fn();
      s.subscribe(l);
      s.batch(() => {
        s.set({ count: 1 });
        s.set({ count: 2 });
        s.set({ name: 'q' });
      });
      expect(l).toHaveBeenCalledTimes(1);
      const [state, previous] = l.mock.calls[0] as [S, S];
      expect(state).toMatchObject({ count: 2, name: 'q' });
      expect(previous).toMatchObject({ count: 0, name: 'a' });
    });

    it('does not notify when the batch changed nothing', () => {
      const s = createStore(init());
      const l = vi.fn();
      s.subscribe(l);
      s.batch(() => {
        s.set({ count: 0 });
      });
      expect(l).not.toHaveBeenCalled();
    });

    it('supports nested batches and replace inside a batch', () => {
      const s = createStore(init());
      const l = vi.fn();
      s.subscribe(l);
      s.batch(() => {
        s.batch(() => {
          s.set({ count: 1 });
        });
        s.replace({ count: 7, name: 'r', list: [] });
      });
      expect(l).toHaveBeenCalledTimes(1);
      expect(s.get().count).toBe(7);
    });

    it('still notifies if fn throws', () => {
      const s = createStore(init());
      const l = vi.fn();
      s.subscribe(l);
      expect(() => {
        s.batch(() => {
          s.set({ count: 3 });
          throw new Error('boom');
        });
      }).toThrow('boom');
      expect(l).toHaveBeenCalledTimes(1);
      expect(s.get().count).toBe(3);
    });
  });

  describe('re-entrancy', () => {
    it('defers sets made inside a listener until the notification finishes', () => {
      const s = createStore(init());
      const seen: number[] = [];
      s.subscribe((st) => {
        seen.push(st.count);
        if (st.count === 1) s.set({ count: 2 });
      });
      s.set({ count: 1 });
      expect(seen).toEqual([1, 2]);
      expect(s.get().count).toBe(2);
    });

    it('a listener removed during notification is not called for the same change twice', () => {
      const s = createStore(init());
      const second = vi.fn();
      const off = s.subscribe(() => {
        offSecond();
      });
      const offSecond = s.subscribe(second);
      s.set({ count: 1 });
      // Snapshot semantics: second was in the snapshot, so it is called once.
      expect(second).toHaveBeenCalledTimes(1);
      off();
      s.set({ count: 2 });
      expect(second).toHaveBeenCalledTimes(1);
    });
  });

  describe('bind', () => {
    it('writes a formatted value onto an element property and keeps it in sync', () => {
      const s = createStore(init());
      const el = { textContent: '' } as unknown as Element;
      const off = bind(
        s,
        (st) => st.count,
        el,
        'textContent',
        (n) => `n=${n}`,
      );
      expect(el.textContent).toBe('n=0');
      s.set({ count: 4 });
      expect(el.textContent).toBe('n=4');
      off();
      s.set({ count: 5 });
      expect(el.textContent).toBe('n=4');
    });

    it('uses the raw value when no formatter is given', () => {
      const s = createStore(init());
      const el = { textContent: '' } as unknown as Element;
      bind(s, (st) => st.name, el, 'textContent');
      expect(el.textContent).toBe('a');
    });
  });

  describe('shallowEqual', () => {
    it('compares arrays and plain objects one level deep', () => {
      expect(shallowEqual([1, 2], [1, 2])).toBe(true);
      expect(shallowEqual([1, 2], [1, 3])).toBe(false);
      expect(shallowEqual([1], [1, 2])).toBe(false);
      expect(shallowEqual({ a: 1 }, { a: 1 })).toBe(true);
      expect(shallowEqual({ a: 1 }, { a: 2 })).toBe(false);
      expect(shallowEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
      expect(shallowEqual(1, 1)).toBe(true);
      expect(shallowEqual(1, 2)).toBe(false);
      expect(shallowEqual(null, {})).toBe(false);
      expect(shallowEqual(NaN, NaN)).toBe(true);
    });
  });
});
