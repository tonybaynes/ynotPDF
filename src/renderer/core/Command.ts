/**
 * `Command` — the unit of undoable change (M00). **Every document change is a Command** so
 * undo/redo, autosave (journal replay) and batch all work for free.
 *
 * Contract:
 * - `do()` applies the change; `undo()` reverts it exactly. Both may be async (they usually
 *   call the engine). The `UndoStack` serialises them, so a command never runs concurrently
 *   with another.
 * - `do()` must be safe to call again after `undo()` (redo).
 * - A rejected do/undo must restore its own pre-call state. Composites roll back completed
 *   children; a child that changes multiple objects owns its own partial-failure rollback.
 * - `merge(next)` lets consecutive commands coalesce (typing characters, dragging a handle):
 *   return a new command representing both, or `null` to keep them separate. The stack calls
 *   it on the *top* command with the *incoming* one, only when both are `mergeable`.
 * - `id` names the kind of change (`"annot.move"`), `label` is what Edit ▸ Undo shows
 *   ("Undo Move annotation").
 */

/**
 * The plain-data form of a command (M20, ADR 0007). `data` must be JSON values only: the
 * journal is written to a recovery file (M21) and replayed for batch (M120).
 */
export interface CommandJson {
  readonly id: string;
  readonly data: unknown;
}

/** Rollback could not restore the pre-operation state; ordinary saving must not conceal it. */
export class CommandRollbackError extends AggregateError {
  constructor(errors: unknown[]) {
    super(
      errors,
      'The operation failed and some changes could not be rolled back. Reopen the document or recover the last checkpoint before continuing.',
    );
    this.name = 'CommandRollbackError';
  }
}

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
   * Serialisable description for the journal/recovery file (M21) and batch replay (M120).
   * Optional: a command without it is replayed from memory only, and `Journal` records that the
   * sequence is not fully replayable rather than silently dropping a step.
   */
  toJSON?(): CommandJson;
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
    await this.perform(this.commands, 'do', 'undo');
  }

  async undo(): Promise<void> {
    await this.perform([...this.commands].reverse(), 'undo', 'do');
  }

  private async perform(
    commands: ReadonlyArray<Command>,
    action: 'do' | 'undo',
    inverse: 'do' | 'undo',
  ): Promise<void> {
    const completed: Command[] = [];
    try {
      for (const command of commands) {
        await command[action]();
        completed.push(command);
      }
    } catch (error) {
      const failures: unknown[] = [];
      for (const command of completed.reverse()) {
        try {
          await command[inverse]();
        } catch (rollbackError) {
          failures.push(rollbackError);
        }
      }
      if (failures.length) throw new CommandRollbackError([error, ...failures]);
      throw error;
    }
  }

  /**
   * Serialises the whole transaction as one entry. Children are written in the journal's own
   * `{ type, payload }` shape, so `Journal` can walk a nested composite with the same code it
   * uses for a top-level entry. A child that cannot serialise contributes `null`, which the
   * journal reads as "this sequence cannot be fully replayed" rather than dropping a step.
   */
  toJSON(): CommandJson {
    return {
      id: COMPOSITE_COMMAND_ID,
      data: {
        id: this.id,
        label: this.label,
        children: this.commands.map((c) => {
          const json = c.toJSON?.();
          return json ? { type: json.id, payload: json.data } : null;
        }),
      },
    };
  }
}

/** The journal type used for a {@link CompositeCommand}. */
export const COMPOSITE_COMMAND_ID = 'core.composite';

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
