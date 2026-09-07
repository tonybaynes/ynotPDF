/**
 * `UndoStack` — one per document, unlimited depth (M00).
 *
 * - `push(cmd)` runs `cmd.do()` and records it. If the previous command can `merge` with it,
 *   the two collapse into one entry (typing coalescing). Pushing clears the redo list.
 * - `undo()` / `redo()` step through history. Operations are serialised: a second call while
 *   one is in flight waits for the first.
 * - `group(label, fn)` records everything pushed inside `fn` as a single composite entry.
 * - `markSaved()` remembers the current position; `isDirty` compares against it.
 * - `subscribe` notifies after every change so menus and the status bar can update.
 */

import { CompositeCommand, type Command } from './Command';

export interface UndoStackState {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Label of the command `undo()` would revert, if any. */
  readonly undoLabel: string | null;
  readonly redoLabel: string | null;
  readonly isDirty: boolean;
  /** Number of entries in the undo list. */
  readonly length: number;
}

export type UndoListener = (state: UndoStackState) => void;

export class UndoStack {
  private undoList: Command[] = [];
  private redoList: Command[] = [];
  private savedIndex = 0;
  private readonly listeners = new Set<UndoListener>();
  private chain: Promise<void> = Promise.resolve();
  private groupStack: { label: string; id: string; commands: Command[] }[] = [];
  /** Merging is suspended while true (e.g. after a pause in typing). */
  private mergeBarrier = false;

  /** All commands applied so far, oldest first (the journal). */
  get journal(): ReadonlyArray<Command> {
    return this.undoList;
  }

  get state(): UndoStackState {
    const top = this.undoList[this.undoList.length - 1];
    const next = this.redoList[this.redoList.length - 1];
    return {
      canUndo: this.undoList.length > 0,
      canRedo: this.redoList.length > 0,
      undoLabel: top?.label ?? null,
      redoLabel: next?.label ?? null,
      isDirty: this.savedIndex !== this.undoList.length,
      length: this.undoList.length,
    };
  }

  get canUndo(): boolean {
    return this.undoList.length > 0;
  }

  get canRedo(): boolean {
    return this.redoList.length > 0;
  }

  get isDirty(): boolean {
    return this.savedIndex !== this.undoList.length;
  }

  subscribe(listener: UndoListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Applies and records a command. Inside `group()` the command is applied immediately but
   * recorded into the group. Resolves after `do()` completes.
   */
  push(cmd: Command): Promise<void> {
    return this.enqueue(async () => {
      await cmd.do();
      const group = this.groupStack[this.groupStack.length - 1];
      if (group) {
        group.commands.push(cmd);
        return;
      }
      this.record(cmd);
      this.notify();
    });
  }

  /** Reverts the most recent command. No-op when nothing to undo. */
  undo(): Promise<void> {
    return this.enqueue(async () => {
      const cmd = this.undoList.pop();
      if (!cmd) return;
      try {
        await cmd.undo();
      } catch (error) {
        this.undoList.push(cmd);
        throw error;
      }
      this.redoList.push(cmd);
      this.mergeBarrier = true;
      this.notify();
    });
  }

  /** Re-applies the most recently undone command. No-op when nothing to redo. */
  redo(): Promise<void> {
    return this.enqueue(async () => {
      const cmd = this.redoList.pop();
      if (!cmd) return;
      try {
        await cmd.do();
      } catch (error) {
        this.redoList.push(cmd);
        throw error;
      }
      this.undoList.push(cmd);
      this.mergeBarrier = true;
      this.notify();
    });
  }

  /**
   * Runs `fn`; every `push` inside becomes part of one composite entry labelled `label`.
   * Nested groups flatten into their parent. If `fn` throws, the commands already applied
   * are undone in reverse and the error is rethrown.
   */
  async group(label: string, fn: () => void | Promise<void>, id = 'group'): Promise<void> {
    const entry = { label, id, commands: [] as Command[] };
    this.groupStack.push(entry);
    try {
      await fn();
    } catch (error) {
      this.groupStack.pop();
      for (let i = entry.commands.length - 1; i >= 0; i--) {
        const c = entry.commands[i];
        if (c) await c.undo();
      }
      throw error;
    }
    this.groupStack.pop();
    if (entry.commands.length === 0) return;
    const parent = this.groupStack[this.groupStack.length - 1];
    const composite = new CompositeCommand(id, label, entry.commands);
    if (parent) {
      parent.commands.push(composite);
      return;
    }
    await this.enqueue(() => {
      this.record(composite);
      this.notify();
    });
  }

  /** Prevents the next push from merging with the current top (e.g. after a typing pause). */
  breakMerge(): void {
    this.mergeBarrier = true;
  }

  /** Marks the current position as saved (`isDirty` becomes false). */
  markSaved(): void {
    this.savedIndex = this.undoList.length;
    this.notify();
  }

  /** Drops all history. The saved marker resets to "clean". */
  clear(): void {
    this.undoList = [];
    this.redoList = [];
    this.savedIndex = 0;
    this.mergeBarrier = false;
    this.notify();
  }

  private record(cmd: Command): void {
    // Branching away from a saved position that lived in the redo list: nothing is saved now.
    if (this.redoList.length > 0 && this.savedIndex > this.undoList.length) this.savedIndex = -1;
    this.redoList = [];
    const top = this.undoList[this.undoList.length - 1];
    if (
      top &&
      !this.mergeBarrier &&
      top.merge &&
      top.mergeable !== false &&
      cmd.mergeable !== false
    ) {
      const merged = top.merge(cmd);
      if (merged) {
        this.undoList[this.undoList.length - 1] = merged;
        // A merge on top of the saved position must still read as dirty.
        if (this.savedIndex === this.undoList.length) this.savedIndex = -1;
        return;
      }
    }
    this.mergeBarrier = false;
    this.undoList.push(cmd);
  }

  private notify(): void {
    const s = this.state;
    for (const l of Array.from(this.listeners)) l(s);
  }

  private enqueue(task: () => void | Promise<void>): Promise<void> {
    const run = this.chain.then(task);
    // Keep the chain alive even when a task rejects.
    this.chain = run.catch(() => undefined);
    return run;
  }
}
