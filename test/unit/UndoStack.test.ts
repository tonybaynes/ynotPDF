import { describe, expect, it, vi } from 'vitest';
import { command, CompositeCommand, SetPropertyCommand, type Command } from '@core/Command';
import { UndoStack } from '@core/UndoStack';

/** A command that appends/removes a value on a log, optionally async. */
function logCmd(
  log: string[],
  value: string,
  opts: { async?: boolean; merge?: boolean } = {},
): Command {
  const wait = () => (opts.async ? new Promise<void>((r) => setTimeout(r, 1)) : undefined);
  const c: Command = {
    id: 'log.append',
    label: `Append ${value}`,
    do: async () => {
      await wait();
      log.push(value);
    },
    undo: async () => {
      await wait();
      log.pop();
    },
  };
  if (opts.merge) {
    return {
      ...c,
      mergeable: true,
      merge(next) {
        if (next.id !== 'log.append') return null;
        // Merged command: does both, undoes both.
        const merged: Command = {
          id: 'log.append',
          label: `${c.label}+${next.label}`,
          mergeable: true,
          do: async () => {
            await c.do();
            await next.do();
          },
          undo: async () => {
            await next.undo();
            await c.undo();
          },
          merge: (n) => (n.id === 'log.append' ? logMerged(merged, n) : null),
        };
        return merged;
      },
    };
  }
  return c;
}

function logMerged(a: Command, b: Command): Command {
  return {
    id: a.id,
    label: `${a.label}+${b.label}`,
    mergeable: true,
    do: async () => {
      await a.do();
      await b.do();
    },
    undo: async () => {
      await b.undo();
      await a.undo();
    },
    merge: (n) => (n.id === a.id ? logMerged({ ...a, label: `${a.label}+${b.label}` }, n) : null),
  };
}

describe('UndoStack', () => {
  it('starts empty and clean', () => {
    const u = new UndoStack();
    expect(u.state).toEqual({
      canUndo: false,
      canRedo: false,
      undoLabel: null,
      redoLabel: null,
      isDirty: false,
      length: 0,
    });
    expect(u.canUndo).toBe(false);
    expect(u.canRedo).toBe(false);
    expect(u.isDirty).toBe(false);
    expect(u.journal).toEqual([]);
  });

  it('push runs do() and records; undo/redo step through', async () => {
    const log: string[] = [];
    const u = new UndoStack();
    await u.push(logCmd(log, 'a'));
    await u.push(logCmd(log, 'b'));
    expect(log).toEqual(['a', 'b']);
    expect(u.state.undoLabel).toBe('Append b');
    expect(u.isDirty).toBe(true);
    await u.undo();
    expect(log).toEqual(['a']);
    expect(u.state.redoLabel).toBe('Append b');
    await u.undo();
    expect(log).toEqual([]);
    expect(u.canUndo).toBe(false);
    await u.redo();
    await u.redo();
    expect(log).toEqual(['a', 'b']);
    expect(u.canRedo).toBe(false);
  });

  it('undo/redo are no-ops when empty', async () => {
    const u = new UndoStack();
    await u.undo();
    await u.redo();
    expect(u.state.length).toBe(0);
  });

  it('push clears the redo list', async () => {
    const log: string[] = [];
    const u = new UndoStack();
    await u.push(logCmd(log, 'a'));
    await u.undo();
    expect(u.canRedo).toBe(true);
    await u.push(logCmd(log, 'c'));
    expect(u.canRedo).toBe(false);
    expect(log).toEqual(['c']);
  });

  it('serialises concurrent async operations in order', async () => {
    const log: string[] = [];
    const u = new UndoStack();
    void u.push(logCmd(log, 'a', { async: true }));
    void u.push(logCmd(log, 'b', { async: true }));
    void u.undo();
    await u.push(logCmd(log, 'c', { async: true }));
    expect(log).toEqual(['a', 'c']);
  });

  it('merges consecutive mergeable commands into one entry', async () => {
    const log: string[] = [];
    const u = new UndoStack();
    await u.push(logCmd(log, 'x', { merge: true }));
    await u.push(logCmd(log, 'y', { merge: true }));
    await u.push(logCmd(log, 'z', { merge: true }));
    expect(log).toEqual(['x', 'y', 'z']);
    expect(u.state.length).toBe(1);
    await u.undo();
    expect(log).toEqual([]);
    await u.redo();
    expect(log).toEqual(['x', 'y', 'z']);
  });

  it('does not merge across breakMerge(), undo or non-mergeable commands', async () => {
    const log: string[] = [];
    const u = new UndoStack();
    await u.push(logCmd(log, 'a', { merge: true }));
    u.breakMerge();
    await u.push(logCmd(log, 'b', { merge: true }));
    expect(u.state.length).toBe(2);
    await u.undo();
    await u.redo();
    await u.push(logCmd(log, 'c', { merge: true }));
    expect(u.state.length).toBe(3);
    await u.push({ ...logCmd(log, 'd', { merge: true }), mergeable: false });
    await u.push(logCmd(log, 'e', { merge: true }));
    expect(u.state.length).toBe(5);
  });

  it('respects merge() returning null', async () => {
    const log: string[] = [];
    const u = new UndoStack();
    await u.push(logCmd(log, 'a', { merge: true }));
    await u.push({ ...logCmd(log, 'b'), id: 'other', mergeable: true, merge: () => null });
    expect(u.state.length).toBe(2);
  });

  it('SetPropertyCommand merges same-target edits and undoes to the first value', async () => {
    const target = { text: '' };
    const u = new UndoStack();
    await u.push(new SetPropertyCommand('type', 'Type', target, 'text', 'h'));
    await u.push(new SetPropertyCommand('type', 'Type', target, 'text', 'he'));
    await u.push(new SetPropertyCommand('type', 'Type', target, 'text', 'hey'));
    expect(target.text).toBe('hey');
    expect(u.state.length).toBe(1);
    await u.undo();
    expect(target.text).toBe('');
    await u.redo();
    expect(target.text).toBe('hey');
    // Different key or target does not merge.
    const other = { text: '' };
    await u.push(new SetPropertyCommand('type', 'Type', other, 'text', 'x'));
    expect(u.state.length).toBe(2);
    const cmd = new SetPropertyCommand('type', 'Type', other, 'text', 'y');
    expect(cmd.merge(logCmd([], 'z'))).toBeNull();
    expect(cmd.merge(new SetPropertyCommand('different', 'D', other, 'text', 'q'))).toBeNull();
  });

  describe('group', () => {
    it('records everything pushed inside as one composite entry', async () => {
      const log: string[] = [];
      const u = new UndoStack();
      await u.group('Add three', async () => {
        await u.push(logCmd(log, '1'));
        await u.push(logCmd(log, '2'));
        await u.push(logCmd(log, '3'));
      });
      expect(log).toEqual(['1', '2', '3']);
      expect(u.state.length).toBe(1);
      expect(u.state.undoLabel).toBe('Add three');
      expect(u.journal[0]).toBeInstanceOf(CompositeCommand);
      await u.undo();
      expect(log).toEqual([]);
      await u.redo();
      expect(log).toEqual(['1', '2', '3']);
    });

    it('flattens nested groups into the parent', async () => {
      const log: string[] = [];
      const u = new UndoStack();
      await u.group('outer', async () => {
        await u.push(logCmd(log, 'a'));
        await u.group('inner', async () => {
          await u.push(logCmd(log, 'b'));
        });
      });
      expect(u.state.length).toBe(1);
      await u.undo();
      expect(log).toEqual([]);
    });

    it('records nothing for an empty group', async () => {
      const u = new UndoStack();
      await u.group('empty', () => undefined);
      expect(u.state.length).toBe(0);
    });

    it('rolls back applied commands and rethrows when fn throws', async () => {
      const log: string[] = [];
      const u = new UndoStack();
      await expect(
        u.group('fail', async () => {
          await u.push(logCmd(log, 'a'));
          throw new Error('nope');
        }),
      ).rejects.toThrow('nope');
      expect(log).toEqual([]);
      expect(u.state.length).toBe(0);
    });
  });

  describe('dirty tracking', () => {
    it('markSaved makes the current position clean; undo/redo away from it is dirty', async () => {
      const log: string[] = [];
      const u = new UndoStack();
      await u.push(logCmd(log, 'a'));
      u.markSaved();
      expect(u.isDirty).toBe(false);
      await u.undo();
      expect(u.isDirty).toBe(true);
      await u.redo();
      expect(u.isDirty).toBe(false);
    });

    it('branching after undo means no position is saved any more', async () => {
      const log: string[] = [];
      const u = new UndoStack();
      await u.push(logCmd(log, 'a'));
      await u.push(logCmd(log, 'b'));
      u.markSaved();
      await u.undo();
      await u.push(logCmd(log, 'c'));
      expect(u.isDirty).toBe(true);
      await u.undo();
      expect(u.isDirty).toBe(true);
    });

    it('a merge on top of the saved position is dirty', async () => {
      const log: string[] = [];
      const u = new UndoStack();
      await u.push(logCmd(log, 'a', { merge: true }));
      u.markSaved();
      await u.push(logCmd(log, 'b', { merge: true }));
      expect(u.state.length).toBe(1);
      expect(u.isDirty).toBe(true);
    });

    it('clear drops history and resets clean', async () => {
      const log: string[] = [];
      const u = new UndoStack();
      await u.push(logCmd(log, 'a'));
      u.clear();
      expect(u.state).toMatchObject({ canUndo: false, canRedo: false, isDirty: false, length: 0 });
    });
  });

  describe('errors', () => {
    it('a failing undo keeps the command on the stack', async () => {
      const u = new UndoStack();
      const bad = command(
        'bad',
        'Bad',
        () => undefined,
        () => {
          throw new Error('cannot undo');
        },
      );
      await u.push(bad);
      await expect(u.undo()).rejects.toThrow('cannot undo');
      expect(u.canUndo).toBe(true);
      expect(u.canRedo).toBe(false);
    });

    it('a failing redo keeps the command in the redo list', async () => {
      const u = new UndoStack();
      let calls = 0;
      const flaky = command(
        'flaky',
        'Flaky',
        () => {
          calls++;
          if (calls === 2) throw new Error('cannot redo');
        },
        () => undefined,
      );
      await u.push(flaky);
      await u.undo();
      await expect(u.redo()).rejects.toThrow('cannot redo');
      expect(u.canRedo).toBe(true);
      // The chain survives a rejection.
      await u.redo();
      expect(u.canUndo).toBe(true);
    });

    it('a failing do() is not recorded', async () => {
      const u = new UndoStack();
      const bad = command(
        'bad',
        'Bad',
        () => {
          throw new Error('cannot do');
        },
        () => undefined,
      );
      await expect(u.push(bad)).rejects.toThrow('cannot do');
      expect(u.state.length).toBe(0);
    });
  });

  it('notifies subscribers on every change and supports unsubscribe', async () => {
    const u = new UndoStack();
    const l = vi.fn();
    const off = u.subscribe(l);
    await u.push(logCmd([], 'a'));
    await u.undo();
    await u.redo();
    u.markSaved();
    u.clear();
    expect(l).toHaveBeenCalledTimes(5);
    off();
    await u.push(logCmd([], 'b'));
    expect(l).toHaveBeenCalledTimes(5);
  });
});

/**
 * Transactions (M20, ADR 0007). `group(label, fn)` covers the callback shape; this is the
 * explicit form, for an interaction that begins on one event and ends on another — a drag
 * that starts on pointer-down and finishes on pointer-up cannot be a callback.
 */
describe('UndoStack transactions', () => {
  it('reports whether one is open, and how deep', async () => {
    const u = new UndoStack();
    expect(u.inTransaction).toBe(false);
    expect(u.transactionDepth).toBe(0);
    u.beginTransaction('Outer');
    expect(u.inTransaction).toBe(true);
    expect(u.transactionDepth).toBe(1);
    u.beginTransaction('Inner');
    expect(u.transactionDepth).toBe(2);
    await u.commit();
    expect(u.transactionDepth).toBe(1);
    await u.commit();
    expect(u.inTransaction).toBe(false);
  });

  it('records everything between begin and commit as one entry', async () => {
    const u = new UndoStack();
    const log: string[] = [];
    u.beginTransaction('Three things');
    await u.push(logCmd(log, 'a'));
    await u.push(logCmd(log, 'b'));
    await u.push(logCmd(log, 'c'));
    expect(log).toEqual(['a', 'b', 'c']);
    expect(u.state.length).toBe(0);
    await u.commit();
    expect(u.state.length).toBe(1);
    expect(u.state.undoLabel).toBe('Three things');
    await u.undo();
    expect(log).toEqual([]);
    await u.redo();
    expect(log).toEqual(['a', 'b', 'c']);
  });

  it('rolls back in reverse and records nothing', async () => {
    const u = new UndoStack();
    const log: string[] = [];
    u.beginTransaction('Abandoned');
    await u.push(logCmd(log, 'a'));
    await u.push(logCmd(log, 'b'));
    await u.rollback();
    expect(log).toEqual([]);
    expect(u.state.length).toBe(0);
    expect(u.canUndo).toBe(false);
  });

  it('an empty transaction records nothing', async () => {
    const u = new UndoStack();
    u.beginTransaction('Nothing');
    await u.commit();
    expect(u.state.length).toBe(0);
  });

  it('nests into one entry, whichever way round the two forms are used', async () => {
    const u = new UndoStack();
    const log: string[] = [];
    u.beginTransaction('Outer');
    await u.push(logCmd(log, 'a'));
    await u.group('Inner', async () => {
      await u.push(logCmd(log, 'b'));
    });
    await u.commit();
    expect(u.state.length).toBe(1);
    expect(u.state.undoLabel).toBe('Outer');
    await u.undo();
    expect(log).toEqual([]);
  });

  it('a transaction inside group() folds into the group', async () => {
    const u = new UndoStack();
    const log: string[] = [];
    await u.group('Group', async () => {
      u.beginTransaction('Inner');
      await u.push(logCmd(log, 'a'));
      await u.commit();
    });
    expect(u.state.length).toBe(1);
    expect(u.state.undoLabel).toBe('Group');
  });

  it('committing or rolling back with none open is an error, not a silent no-op', async () => {
    const u = new UndoStack();
    await expect(u.commit()).rejects.toThrow('commit() without beginTransaction()');
    await expect(u.rollback()).rejects.toThrow('rollback() without beginTransaction()');
  });

  it('clear() abandons an open transaction', async () => {
    const u = new UndoStack();
    u.beginTransaction('Open');
    await u.push(logCmd([], 'a'));
    u.clear();
    expect(u.inTransaction).toBe(false);
    expect(u.state.length).toBe(0);
  });
});
