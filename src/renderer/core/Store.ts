/**
 * `Store` — the in-house reactive state container (M00). Vanilla DOM, no framework:
 * state changes flow to the DOM through subscriptions.
 *
 * ```ts
 * const ui = createStore({ zoom: 1, page: 0 });
 * ui.select(s => s.zoom, z => (label.textContent = `${Math.round(z * 100)}%`));
 * ui.set({ zoom: 1.5 });                       // notifies zoom listeners only
 * ui.set(s => ({ page: s.page + 1 }));         // functional update
 * ui.batch(() => { ui.set({ zoom: 2 }); ui.set({ page: 3 }); }); // one notification
 * ```
 *
 * Semantics:
 * - State is treated as immutable: `set` shallow-merges a patch into a *new* object.
 *   Listeners receive `(state, previous)`.
 * - `select` fires only when the selected value changes (`Object.is` by default) and fires
 *   once immediately on subscribe so DOM bindings start in sync (opt out with `{ immediate: false }`).
 * - Nested `set` inside a listener is applied after the current notification finishes;
 *   listeners never observe out-of-order states.
 * - `batch` coalesces any number of `set`s into one notification.
 */

export type Unsubscribe = () => void;
export type Listener<T> = (state: Readonly<T>, previous: Readonly<T>) => void;
export type Selector<T, S> = (state: Readonly<T>) => S;
export type Equality<S> = (a: S, b: S) => boolean;
export type Patch<T> = Partial<T> | ((state: Readonly<T>) => Partial<T>);

export interface SelectOptions<S> {
  /** Custom equality; defaults to `Object.is`. Use `shallowEqual` for arrays/objects. */
  readonly equals?: Equality<S>;
  /** Fire the listener once with the current value on subscribe (default true). */
  readonly immediate?: boolean;
}

export interface Store<T extends object> {
  /** Current state (frozen in dev; never mutate). */
  get(): Readonly<T>;
  /** Shallow-merge a patch (or the result of an updater) into the state. */
  set(patch: Patch<T>): void;
  /** Replace the whole state. */
  replace(next: T): void;
  /** Listen to every change. */
  subscribe(listener: Listener<T>): Unsubscribe;
  /** Listen to a derived value; fires only when it changes. */
  select<S>(
    selector: Selector<T, S>,
    listener: (value: S, previous: S) => void,
    options?: SelectOptions<S>,
  ): Unsubscribe;
  /** Run `fn`; notify once at the end even if it calls `set` many times. */
  batch(fn: () => void): void;
  /** Number of active listeners (for tests and leak checks). */
  readonly listenerCount: number;
}

/** Shallow equality for arrays and plain objects; `Object.is` for everything else. */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return (
      ka.length === kb.length &&
      ka.every((k) =>
        Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
      )
    );
  }
  return false;
}

/** Creates a store. `initial` is copied; the caller's object is not retained. */
export function createStore<T extends object>(initial: T): Store<T> {
  let state: Readonly<T> = { ...initial };
  const listeners = new Set<Listener<T>>();
  let batchDepth = 0;
  let batchPrevious: Readonly<T> | null = null;
  let notifying = false;
  const queued: Patch<T>[] = [];

  function notify(previous: Readonly<T>): void {
    if (previous === state) return;
    notifying = true;
    try {
      for (const l of Array.from(listeners)) l(state, previous);
    } finally {
      notifying = false;
    }
    // Apply sets that arrived while notifying, in order, each with its own notification.
    while (queued.length > 0) {
      const next = queued.shift();
      if (next !== undefined) applyPatch(next);
    }
  }

  function applyPatch(patch: Patch<T>): void {
    const partial = typeof patch === 'function' ? patch(state) : patch;
    let changed = false;
    for (const key of Object.keys(partial) as (keyof T)[]) {
      if (!Object.is(partial[key], state[key])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    const previous = state;
    state = { ...state, ...partial };
    if (batchDepth > 0) {
      batchPrevious ??= previous;
      return;
    }
    notify(previous);
  }

  const store: Store<T> = {
    get: () => state,
    set(patch) {
      if (notifying) {
        queued.push(patch);
        return;
      }
      applyPatch(patch);
    },
    replace(next) {
      const previous = state;
      state = { ...next };
      if (batchDepth > 0) {
        batchPrevious ??= previous;
        return;
      }
      notify(previous);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    select(selector, listener, options) {
      const equals = options?.equals ?? Object.is;
      let current = selector(state);
      const unsub = store.subscribe((next) => {
        const value = selector(next);
        if (equals(value, current)) return;
        const previous = current;
        current = value;
        listener(value, previous);
      });
      if (options?.immediate !== false) listener(current, current);
      return unsub;
    },
    batch(fn) {
      batchDepth++;
      try {
        fn();
      } finally {
        batchDepth--;
        if (batchDepth === 0 && batchPrevious !== null) {
          const previous = batchPrevious;
          batchPrevious = null;
          notify(previous);
        }
      }
    },
    get listenerCount() {
      return listeners.size;
    },
  };
  return store;
}

/**
 * Binds a DOM element property to a store value. Returns the unsubscribe function.
 * ```ts
 * bind(ui, s => s.page + 1, el, 'textContent');
 * ```
 */
export function bind<T extends object, S, E extends Element, K extends keyof E>(
  store: Store<T>,
  selector: Selector<T, S>,
  element: E,
  property: K,
  format: (value: S) => E[K] = (v) => v as unknown as E[K],
): Unsubscribe {
  return store.select(selector, (value) => {
    element[property] = format(value);
  });
}
