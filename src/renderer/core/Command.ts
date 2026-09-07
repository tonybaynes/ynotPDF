/**
 * `Command` — the unit of undoable change (M00). **Every document change is a Command** so
 * undo/redo, autosave (journal replay) and batch all work for free.
 *
 * Contract:
 * - `do()` applies the change; `undo()` reverts it exactly. Both may be async (they usually
 *   call the engine). The `UndoStack` serialises them, so a command never runs concurrently
 *   with another.
 * - `do()` must be safe to call again after `undo()` (redo).
 * - `merge(next)` lets consecutive commands coalesce (typing characters, dragging a handle):
 *   return a new command representing both, or `null` to keep them separate. The stack calls
 *   it on the *top* command with the *incoming* one, only when both are `mergeable`.
 * - `id` names the kind of change (`"annot.move"`), `label` is what Edit ▸ Undo shows
 *   ("Undo Move annotation").
 */

export interface Command {
  /** Kind of change, dotted lowercase, e.g. `"page.rotate"`. */
  readonly id: string;
  /** Human label for the Undo/Redo menu, e.g. `"Rotate page"`. */
  readonly label: string;
  /** Apply the change. */
  do(): void | Promise<void>;
  /** Revert the change exactly. */
  undo(): void | Promise<void>;
  /**
   * Try to coalesce with the command that follows. Return a command equivalent to
   * "this then next", or `null` to refuse. Only called when `mergeable` is not false.
   */
  merge?(next: Command): Command | null;
  /** Whether this command may participate in merging (default true when `merge` exists). */
  readonly mergeable?: boolean;
  /**
   * Serialisable description for the journal/recovery file (M21). Optional in M00; commands
   * without it are replayed from memory only.
   */
  toJSON?(): { readonly id: string; readonly data: unknown };
}

/** Build a command from two closures. */
export function command(
  id: string,
  label: string,
  doFn: () => void | Promise<void>,
  undoFn: () => void | Promise<void>,
  extra?: Pick<Command, 'merge' | 'mergeable' | 'toJSON'>,
): Command {
  return { id, label, do: doFn, undo: undoFn, ...extra };
}

/**
 * A command made of several commands applied in order and undone in reverse. Used by
 * `UndoStack.group()` for batch operations ("Delete 5 pages").
 */
export class CompositeCommand implements Command {
  readonly id: string;
  readonly label: string;
  readonly commands: ReadonlyArray<Command>;

  constructor(id: string, label: string, commands: ReadonlyArray<Command>) {
    this.id = id;
    this.label = label;
    this.commands = commands;
  }

  async do(): Promise<void> {
    for (const c of this.commands) await c.do();
  }

  async undo(): Promise<void> {
    for (let i = this.commands.length - 1; i >= 0; i--) {
      const c = this.commands[i];
      if (c) await c.undo();
    }
  }
}

/**
 * A command that swaps a property on a target object. Handy for simple state changes and
 * for merging consecutive edits of the same property (typing, dragging).
 */
export class SetPropertyCommand<T extends object, K extends keyof T> implements Command {
  readonly id: string;
  readonly label: string;
  readonly mergeable = true;
  private readonly target: T;
  private readonly key: K;
  private readonly before: T[K];
  private readonly after: T[K];

  /** `initial` overrides the captured "before" value (used when merging). */
  constructor(
    id: string,
    label: string,
    target: T,
    key: K,
    after: T[K],
    initial?: { readonly before: T[K] },
  ) {
    this.id = id;
    this.label = label;
    this.target = target;
    this.key = key;
    this.before = initial ? initial.before : target[key];
    this.after = after;
  }

  do(): void {
    this.target[this.key] = this.after;
  }

  undo(): void {
    this.target[this.key] = this.before;
  }

  /** Merges with a following SetPropertyCommand on the same target+key. */
  merge(next: Command): Command | null {
    if (!(next instanceof SetPropertyCommand)) return null;
    const other = next as SetPropertyCommand<T, K>;
    if (other.target !== this.target || other.key !== this.key || other.id !== this.id) return null;
    // Preserve the original "before" so undo returns to the very first value.
    return new SetPropertyCommand(this.id, this.label, this.target, this.key, other.after, {
      before: this.before,
    });
  }
}
