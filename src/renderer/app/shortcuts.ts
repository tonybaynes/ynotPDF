/**
 * Shortcut manager (M00 dispatcher, grown in M02). Translates keydown events into normalised
 * shortcut keys and runs the bound command. `editor`-scoped shortcuts are ignored while typing
 * in inputs; `global` ones always fire. Also:
 *
 * - **Conflicts**: the Registry keeps "last binding wins"; the manager records every key that
 *   was bound more than once and, in dev builds, warns with both command ids. M130's editor
 *   reads `conflicts()`.
 * - **Alt = key tips**: a bare Alt press (no other key) toggles ribbon key tips; Alt held with a
 *   key is a normal chord.
 * - **Platform mapping**: `Mod` resolves to Cmd on macOS and Ctrl elsewhere via `keyFromEvent`.
 */

import { keyFromEvent, normalizeKey, type Registry } from '@core/Registry';
import type { ShortcutSpec } from '@shared/module';

export interface ShortcutConflict {
  readonly key: string;
  /** Command ids bound to the key, in registration order; the last one is active. */
  readonly commands: ReadonlyArray<string>;
}

export interface ShortcutManagerOptions {
  readonly isMac: boolean;
  /** Called on a bare Alt press/release cycle (key tips). */
  readonly onAltTap?: () => void;
  /** Warn about conflicts (defaults to `import.meta.env.DEV`). */
  readonly warn?: boolean;
}

/** Finds keys bound by more than one command across the given manifests' shortcuts. */
export function findConflicts(
  bindings: ReadonlyArray<{ key: string; command: string }>,
): ShortcutConflict[] {
  const byKey = new Map<string, string[]>();
  for (const b of bindings) {
    const key = normalizeKey(b.key);
    const list = byKey.get(key) ?? [];
    if (!list.includes(b.command)) list.push(b.command);
    byKey.set(key, list);
  }
  return Array.from(byKey.entries())
    .filter(([, cmds]) => cmds.length > 1)
    .map(([key, commands]) => ({ key, commands }));
}

/** True when the event target is somewhere the user is typing. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color'].includes(
      target.type,
    );
  }
  return (
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  );
}

export class ShortcutManager {
  private readonly bindings: { key: string; command: string }[] = [];
  private altPending = false;
  private disposeFn: (() => void) | null = null;

  private readonly registry: Registry;
  private readonly options: ShortcutManagerOptions;

  constructor(registry: Registry, options: ShortcutManagerOptions) {
    this.registry = registry;
    this.options = options;
  }

  /** Records every binding from every registered manifest (for conflict reporting). */
  collect(): void {
    this.bindings.length = 0;
    for (const m of this.registry.modules()) {
      for (const c of m.commands ?? [])
        if (c.shortcut) this.bindings.push({ key: c.shortcut, command: c.id });
      for (const s of m.shortcuts ?? []) this.bindings.push({ key: s.key, command: s.command });
    }
    const conflicts = this.conflicts();
    const warn = this.options.warn ?? import.meta.env.DEV;
    if (warn && conflicts.length) {
      for (const c of conflicts) {
        console.warn(
          `shortcut ${c.key} is bound by ${c.commands.join(', ')} — the last one (${c.commands[c.commands.length - 1] ?? ''}) wins`,
        );
      }
    }
  }

  conflicts(): ShortcutConflict[] {
    return findConflicts(this.bindings);
  }

  /** The active binding for a key, if any. */
  lookup(key: string): ShortcutSpec | undefined {
    return this.registry.shortcutForKey(key);
  }

  install(): () => void {
    this.disposeFn?.();
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Alt') {
        this.altPending = !e.repeat;
        return;
      }
      this.altPending = false;
      this.handle(e);
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key !== 'Alt') return;
      if (this.altPending) {
        this.altPending = false;
        e.preventDefault();
        this.options.onAltTap?.();
      }
    };
    const onBlur = (): void => {
      this.altPending = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    this.disposeFn = () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
    this.collect();
    this.registry.subscribe(() => {
      this.collect();
    });
    return this.disposeFn;
  }

  /** Handles one keydown. Returns true when a command ran (or was refused as disabled). */
  handle(e: KeyboardEvent): boolean {
    if (e.defaultPrevented) return false;
    const key = keyFromEvent(e, this.options.isMac);
    if (!key) return false;
    const spec = this.registry.shortcutForKey(key);
    if (!spec) return false;
    if (isTypingTarget(e.target) && spec.scope !== 'global') return false;
    // Inside an open modal dialog only global shortcuts apply.
    if (document.querySelector('dialog[open]:modal') && spec.scope !== 'global') return false;
    if (!this.registry.isEnabled(spec.command)) return false;
    e.preventDefault();
    e.stopPropagation();
    void this.registry.run(spec.command, spec.args ?? {}).catch((error: unknown) => {
      console.error(`shortcut ${key} → ${spec.command} failed`, error);
    });
    return true;
  }
}

/** M00-compatible entry point: installs a manager with defaults and returns its disposer. */
export function installShortcuts(
  registry: Registry,
  isMac: boolean,
  options: Omit<ShortcutManagerOptions, 'isMac'> = {},
): () => void {
  return new ShortcutManager(registry, { isMac, ...options }).install();
}
