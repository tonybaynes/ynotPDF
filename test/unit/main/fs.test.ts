/**
 * The main process's filesystem layer (M21): atomic writes, the read-only probe, the recovery
 * store, the changed-on-disk watcher and the close broker — plus M12's temp-file naming, which
 * is the one place a string that came out of a PDF becomes a path on the operator's disk.
 *
 * These run against a real temporary directory rather than a mocked `fs`, because what is being
 * tested is exactly the behaviour of a real filesystem — that a rename is atomic, that a
 * read-only file reports itself, that a watcher settles.
 */

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { probeFile, writeAtomic } from '../../../src/main/fs/atomic';
import { CloseBroker } from '../../../src/main/fs/lifecycle';
import { RecoveryStore } from '../../../src/main/fs/recovery';
import { FileWatchers } from '../../../src/main/fs/watcher';
import { safeFileName } from '../../../src/main/files';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ynot-m21-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const read = (path: string): string => readFileSync(path, 'utf8');

describe('writeAtomic', () => {
  it('writes the file and leaves no temporary behind', async () => {
    const path = join(dir, 'doc.pdf');
    const result = await writeAtomic(path, bytes('hello'));
    expect(result.path).toBe(path);
    expect(result.bytesWritten).toBe(5);
    expect(result.backupPath).toBeNull();
    expect(read(path)).toBe('hello');
    expect(readdirSync(dir)).toEqual(['doc.pdf']);
  });

  it('replaces an existing file in one step', async () => {
    const path = join(dir, 'doc.pdf');
    writeFileSync(path, 'old');
    await writeAtomic(path, bytes('new'));
    expect(read(path)).toBe('new');
    expect(readdirSync(dir)).toEqual(['doc.pdf']);
  });

  it('keeps the previous version when asked, and replaces an older backup', async () => {
    const path = join(dir, 'doc.pdf');
    writeFileSync(path, 'first');
    const one = await writeAtomic(path, bytes('second'), { backup: true });
    expect(one.backupPath).toBe(`${path}.bak`);
    expect(read(`${path}.bak`)).toBe('first');

    await writeAtomic(path, bytes('third'), { backup: true });
    expect(read(path)).toBe('third');
    expect(read(`${path}.bak`)).toBe('second');
  });

  it('there is no backup to make when the file is new', async () => {
    const path = join(dir, 'fresh.pdf');
    const result = await writeAtomic(path, bytes('x'), { backup: true });
    expect(result.backupPath).toBeNull();
    expect(existsSync(`${path}.bak`)).toBe(false);
  });

  it('creates the folder when it is not there', async () => {
    const path = join(dir, 'nested', 'deeper', 'doc.pdf');
    await writeAtomic(path, bytes('x'));
    expect(read(path)).toBe('x');
  });

  it('a failed write leaves the original alone and no temporary behind', async () => {
    const path = join(dir, 'sub', 'doc.pdf');
    // A path whose parent is a file, not a folder: the write cannot happen.
    writeFileSync(join(dir, 'sub'), 'in the way');
    await expect(writeAtomic(path, bytes('x'))).rejects.toThrow();
    expect(read(join(dir, 'sub'))).toBe('in the way');
    expect(readdirSync(dir)).toEqual(['sub']);
  });

  it('two writes to the same path do not collide', async () => {
    const path = join(dir, 'doc.pdf');
    await Promise.all([writeAtomic(path, bytes('aaaa')), writeAtomic(path, bytes('bbbb'))]);
    // Whichever landed last, the file is one of them whole — never a mixture.
    expect(['aaaa', 'bbbb']).toContain(read(path));
    expect(readdirSync(dir)).toEqual(['doc.pdf']);
  });
});

describe('probeFile', () => {
  it('reports a file that is there and can be written', async () => {
    const path = join(dir, 'doc.pdf');
    writeFileSync(path, 'hello');
    const probe = await probeFile(path);
    expect(probe.exists).toBe(true);
    expect(probe.size).toBe(5);
    expect(probe.writable).toBe(true);
    expect(probe.directoryWritable).toBe(true);
    expect(probe.readOnly).toBe(false);
    expect(probe.modifiedAt).toBeGreaterThan(0);
  });

  it('a missing file is not read-only — it is a file that can still be created', async () => {
    const probe = await probeFile(join(dir, 'nope.pdf'));
    expect(probe.exists).toBe(false);
    expect(probe.readOnly).toBe(false);
    expect(probe.directoryWritable).toBe(true);
  });

  it('a read-only file reports itself', async () => {
    const path = join(dir, 'locked.pdf');
    writeFileSync(path, 'hello');
    chmodSync(path, 0o444);
    try {
      const probe = await probeFile(path);
      // Windows honours the read-only attribute; POSIX honours the mode for a non-root user.
      // Running as root defeats both, so the assertion is on the pair rather than on one bit.
      if (probe.writable) {
        expect(probe.readOnly).toBe(false);
      } else {
        expect(probe.readOnly).toBe(true);
      }
    } finally {
      chmodSync(path, 0o644);
    }
  });
});

describe('the recovery store', () => {
  it('saves, reads, lists and discards', async () => {
    const store = new RecoveryStore(dir);
    await store.save('doc-1', '{"a":1}');
    await store.save('doc-2', '{"a":2}');
    expect(await store.read('doc-1')).toBe('{"a":1}');

    const list = await store.list();
    expect(list.map((e) => e.id).sort()).toEqual(['doc-1', 'doc-2']);
    expect(list[0]?.payload).toContain('"a"');

    await store.discard('doc-1');
    expect(await store.read('doc-1')).toBeNull();
    expect((await store.list()).map((e) => e.id)).toEqual(['doc-2']);

    await store.clear();
    expect(await store.list()).toEqual([]);
  });

  it('lists nothing rather than failing when the folder has never existed', async () => {
    const store = new RecoveryStore(join(dir, 'never-made'));
    expect(await store.list()).toEqual([]);
    expect(await store.read('anything')).toBeNull();
    // Discarding what is not there is the state we wanted, not an error.
    await expect(store.discard('anything')).resolves.toBeUndefined();
  });

  it('refuses an id that would escape the folder', async () => {
    const store = new RecoveryStore(dir);
    for (const id of ['../escape', 'a/b', '', 'x'.repeat(200), 'has space']) {
      await expect(store.save(id, '{}')).rejects.toThrow(/not a usable recovery id/i);
    }
  });

  it('ignores files in the folder that are not records', async () => {
    const store = new RecoveryStore(dir);
    await store.save('real', '{}');
    writeFileSync(join(store.path, 'notes.txt'), 'hello');
    expect((await store.list()).map((e) => e.id)).toEqual(['real']);
  });

  it('replaces a record rather than appending to it', async () => {
    const store = new RecoveryStore(dir);
    await store.save('doc', '{"n":1}');
    await store.save('doc', '{"n":2}');
    expect(await store.read('doc')).toBe('{"n":2}');
  });
});

describe('the changed-on-disk watcher', () => {
  /** Waits for a change to be reported, or resolves `false` after `ms`. */
  function reported(changes: string[], path: string, ms = 3000): Promise<boolean> {
    const started = Date.now();
    return new Promise((resolve) => {
      const tick = (): void => {
        if (changes.includes(path)) {
          resolve(true);
          return;
        }
        if (Date.now() - started > ms) {
          resolve(false);
          return;
        }
        setTimeout(tick, 25);
      };
      tick();
    });
  }

  it('reports a change made by someone else, once', async () => {
    const path = join(dir, 'doc.pdf');
    writeFileSync(path, 'one');
    const changes: string[] = [];
    const watchers = new FileWatchers((p) => {
      changes.push(p);
    });
    watchers.watch(path, 1);
    try {
      // chokidar needs a moment to be listening before a change counts as one.
      await new Promise((r) => {
        setTimeout(r, 300);
      });
      writeFileSync(path, 'two');
      expect(await reported(changes, path)).toBe(true);
    } finally {
      await watchers.closeAll();
    }
  });

  it('says nothing about a write we made ourselves', async () => {
    const path = join(dir, 'doc.pdf');
    writeFileSync(path, 'one');
    const changes: string[] = [];
    const watchers = new FileWatchers((p) => {
      changes.push(p);
    });
    watchers.watch(path, 1);
    try {
      await new Promise((r) => {
        setTimeout(r, 300);
      });
      watchers.suspend(path);
      await writeAtomic(path, bytes('ours'));
      await new Promise((r) => {
        setTimeout(r, 800);
      });
      expect(changes).toEqual([]);
    } finally {
      await watchers.closeAll();
    }
  });

  it('a path is watched while anyone holds it and dropped when the last owner lets go', () => {
    const path = join(dir, 'doc.pdf');
    writeFileSync(path, 'one');
    const watchers = new FileWatchers(() => undefined);
    watchers.watch(path, 1);
    watchers.watch(path, 2);
    expect(watchers.watched).toEqual([path]);
    watchers.unwatch(path, 1);
    expect(watchers.watched).toEqual([path]);
    watchers.unwatch(path, 2);
    expect(watchers.watched).toEqual([]);
    // Unwatching what is not watched is not an error.
    watchers.unwatch(path, 2);
  });

  it('closing a window drops everything it was watching', () => {
    const a = join(dir, 'a.pdf');
    const b = join(dir, 'b.pdf');
    writeFileSync(a, '1');
    writeFileSync(b, '2');
    const watchers = new FileWatchers(() => undefined);
    watchers.watch(a, 1);
    watchers.watch(b, 1);
    watchers.watch(b, 2);
    watchers.release(1);
    expect(watchers.watched).toEqual([b]);
  });

  it('an early resume ends the mute, because a later change really is someone else’s', () => {
    const path = join(dir, 'doc.pdf');
    const changes: string[] = [];
    const watchers = new FileWatchers((p) => {
      changes.push(p);
    });
    watchers.suspend(path, 10_000);
    watchers.resume(path);
    // Nothing to assert on the filesystem here; the mute map is the state under test, and it is
    // read by the reporter — which the "reports a change" test above already covers.
    expect(watchers.watched).toEqual([]);
  });
});

describe('the close broker', () => {
  it('holds nothing back until a window says it has unsaved work', () => {
    const broker = new CloseBroker(50);
    expect(broker.anyUnsaved).toBe(false);
    expect(broker.shouldHold(1)).toBe(false);
    broker.setUnsaved(1, true);
    expect(broker.anyUnsaved).toBe(true);
    expect(broker.shouldHold(1)).toBe(true);
    // A different window is unaffected.
    expect(broker.shouldHold(2)).toBe(false);
  });

  it('lets the window go once the renderer agrees, and does not ask twice', async () => {
    const broker = new CloseBroker(1000);
    broker.setUnsaved(1, true);
    let asked = 0;
    const answer = broker.askWindow(1, () => {
      asked++;
      queueMicrotask(() => {
        broker.answerWindow(1, true);
      });
    });
    expect(await answer).toBe(true);
    expect(asked).toBe(1);
    // Agreed: the next close event goes straight through.
    expect(broker.shouldHold(1)).toBe(false);
  });

  it('a cancel keeps the window, and it can be asked again', async () => {
    const broker = new CloseBroker(1000);
    broker.setUnsaved(1, true);
    const first = broker.askWindow(1, () => {
      queueMicrotask(() => {
        broker.answerWindow(1, false);
      });
    });
    expect(await first).toBe(false);
    expect(broker.shouldHold(1)).toBe(true);

    const second = broker.askWindow(1, () => {
      queueMicrotask(() => {
        broker.answerWindow(1, true);
      });
    });
    expect(await second).toBe(true);
  });

  it('a second ask while one is outstanding is refused rather than stacking dialogs', async () => {
    const broker = new CloseBroker(1000);
    broker.setUnsaved(1, true);
    const first = broker.askWindow(1, () => undefined);
    expect(await broker.askWindow(1, () => undefined)).toBe(false);
    broker.answerWindow(1, true);
    expect(await first).toBe(true);
  });

  it('a renderer that never answers releases the window rather than wedging the app', async () => {
    const broker = new CloseBroker(30);
    broker.setUnsaved(1, true);
    expect(await broker.askWindow(1, () => undefined)).toBe(true);
  });

  it('a quit is asked once and remembered', async () => {
    const broker = new CloseBroker(1000);
    broker.setUnsaved(1, true);
    expect(broker.quitApproved).toBe(false);
    const asked = broker.askQuit(() => {
      queueMicrotask(() => {
        broker.answerQuit(true);
      });
    });
    expect(await asked).toBe(true);
    expect(broker.quitApproved).toBe(true);
    // Already agreed: the second `before-quit` does not ask again.
    expect(await broker.askQuit(() => expect.unreachable('asked twice'))).toBe(true);
  });

  it('a refused quit can be asked again', async () => {
    const broker = new CloseBroker(1000);
    broker.setUnsaved(1, true);
    const first = broker.askQuit(() => {
      queueMicrotask(() => {
        broker.answerQuit(false);
      });
    });
    expect(await first).toBe(false);
    expect(broker.quitApproved).toBe(false);
  });

  it('forgetting a window clears everything about it', () => {
    const broker = new CloseBroker(50);
    broker.setUnsaved(1, true);
    broker.approve(1);
    broker.forget(1);
    expect(broker.anyUnsaved).toBe(false);
    expect(broker.shouldHold(1)).toBe(false);
  });

  it('an approved window is let through without being asked', () => {
    const broker = new CloseBroker(50);
    broker.setUnsaved(1, true);
    broker.approve(1);
    expect(broker.shouldHold(1)).toBe(false);
  });
});

describe('safeFileName (M12, ADR 0011)', () => {
  it('keeps an ordinary name as it is', () => {
    expect(safeFileName('boarding pass.pdf')).toBe('boarding pass.pdf');
    expect(safeFileName('résumé (2).docx')).toBe('résumé (2).docx');
  });

  it('refuses to walk out of the temp directory', () => {
    // A file specification inside a PDF is free to say this; nothing else stops it. What has to
    // be true is that the result is one path segment — dots without a separator go nowhere.
    for (const name of ['../../.bashrc', 'C:\\Windows\\evil.exe', '/etc/passwd', 'a/b/c']) {
      const safe = safeFileName(name);
      expect(basename(safe)).toBe(safe);
      expect(safe.startsWith('.')).toBe(false);
    }
    expect(safeFileName('../../.bashrc')).not.toContain('/');
    expect(safeFileName('C:\\Windows\\System32\\evil.exe')).not.toContain('\\');
    expect(safeFileName('/etc/passwd')).not.toContain('/');
  });

  it('drops control characters and the punctuation Windows will not take', () => {
    expect(safeFileName('a\u0000b\u001fc\u007fd')).toBe('a_b_c_d');
    expect(safeFileName('a:b*c?d"e<f>g|h')).toBe('a_b_c_d_e_f_g_h');
  });

  it('never returns nothing, and never returns a name Windows reserves', () => {
    expect(safeFileName('')).toBe('attachment');
    expect(safeFileName('...')).toBe('attachment');
    expect(safeFileName('   ')).toBe('attachment');
    expect(safeFileName('CON')).toBe('_CON');
    expect(safeFileName('lpt1.txt')).toBe('_lpt1.txt');
    expect(safeFileName('connect.pdf')).toBe('connect.pdf');
  });

  it('caps the length', () => {
    expect(safeFileName('x'.repeat(400)).length).toBeLessThanOrEqual(120);
  });
});
