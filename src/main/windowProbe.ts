/**
 * Records what happens to every window, so "I saw something flash" can become evidence.
 *
 * An e2e run parks its windows off-screen and transparent so it never interrupts Tony's machine
 * (`CLAUDE.md`). He reported seeing the outline of a window flash up during runs, every now and
 * again — and a visual event that rare cannot be caught by watching for it, or reproduced on
 * demand. This writes a line for every window created, shown, hidden, maximised, restored,
 * focused or taken full screen, with where it was and whether anyone could have seen it there.
 *
 * Off by default and free when off. Turn it on by naming a file:
 *
 * ```bash
 * YNOT_WINDOW_PROBE=/tmp/windows.log npm run e2e
 * ```
 *
 * Then look for the moment that matters — a window both visible and on a real display:
 *
 * ```bash
 * grep -v 'bounds=-' /tmp/windows.log | grep 'visible=true'
 * ```
 *
 * A run where that prints nothing is a run where no window ever reached the screen.
 *
 * **Read it for what it is.** It records the events Electron reports; it cannot see a frame the
 * compositor drew on its own, so an empty log narrows the search rather than closing it. And it
 * observes a system it is part of: a *test* that maximises a window will show up here as a
 * maximise, which is how a first attempt at this measured its own footprint and mistook it for
 * the fault (2026-09-11).
 */

import { appendFileSync } from 'node:fs';
import type { App, BrowserWindow } from 'electron';

function line(what: string, win: BrowserWindow): string {
  const b = win.getBounds();
  return [
    new Date().toISOString(),
    what,
    `id=${String(win.id)}`,
    `opacity=${String(win.getOpacity())}`,
    `visible=${String(win.isVisible())}`,
    `bounds=${String(b.x)},${String(b.y)}`,
    `${String(b.width)}x${String(b.height)}`,
  ].join(' ');
}

/**
 * Starts recording, if `YNOT_WINDOW_PROBE` names a file. Call once, before any window exists.
 *
 * A diagnostic that breaks the thing it is diagnosing is worse than none, so every write is
 * swallowed: a full disk or an unwritable path costs the log, never the run.
 */
export function installWindowProbe(app: App, path = process.env['YNOT_WINDOW_PROBE']): void {
  if (path === undefined || path === '') return;
  const note = (what: string, win: BrowserWindow): void => {
    try {
      appendFileSync(path, `${line(what, win)}\n`);
    } catch {
      /* never break a run for a log */
    }
  };
  app.on('browser-window-created', (_event, win) => {
    note('created', win);
    // One call each: `BrowserWindow.on` is overloaded per event name, so a loop over a union of
    // names does not type. `hide` and `blur` earn their place by bracketing an exposure — a
    // `show` with no `hide` after it is a window still sitting there.
    win.on('show', () => {
      note('show', win);
    });
    win.on('hide', () => {
      note('hide', win);
    });
    win.on('maximize', () => {
      note('maximize', win);
    });
    win.on('unmaximize', () => {
      note('unmaximize', win);
    });
    win.on('restore', () => {
      note('restore', win);
    });
    win.on('focus', () => {
      note('focus', win);
    });
    win.on('blur', () => {
      note('blur', win);
    });
    win.on('enter-full-screen', () => {
      note('enter-full-screen', win);
    });
    win.on('leave-full-screen', () => {
      note('leave-full-screen', win);
    });
  });
}
