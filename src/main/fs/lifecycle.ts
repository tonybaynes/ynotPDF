/**
 * Close and quit interception (M21).
 *
 * Closing a window with unsaved work must give the reader Save / Don't save / Cancel, and only
 * the renderer can ask that — it owns the documents and the dialogs. So main holds the close
 * back, asks, and waits for an answer.
 *
 * The design rule that keeps this safe: **nothing is intercepted unless a window has said it has
 * unsaved work.** A clean app quits at once, an app with no windows quits at once, and a
 * renderer that has stopped answering releases the app after {@link ANSWER_TIMEOUT_MS} rather
 * than holding it open for ever. The cost of getting this wrong is an app that cannot be closed,
 * so every path out of it is a path that lets the window go.
 */

import type { BrowserWindow } from 'electron';

/** How long the renderer gets to answer before main stops waiting and lets the window close. */
export const ANSWER_TIMEOUT_MS = 5_000;

type Answer = (allowed: boolean) => void;

/**
 * Tracks which windows hold unsaved work and brokers the one question main asks them.
 *
 * Deliberately free of `electron` imports beyond the window type, so it is unit-testable with a
 * fake window.
 */
export class CloseBroker {
  private readonly unsaved = new Set<number>();
  /** Windows whose close has already been agreed, so the next `close` event goes through. */
  private readonly agreed = new Set<number>();
  private readonly pending = new Map<number, Answer>();
  private quitAnswer: Answer | null = null;
  private quitAgreed = false;
  private readonly timeout: number;

  constructor(timeout = ANSWER_TIMEOUT_MS) {
    this.timeout = timeout;
  }

  /** True while any window is holding unsaved work. */
  get anyUnsaved(): boolean {
    return this.unsaved.size > 0;
  }

  setUnsaved(windowId: number, unsaved: boolean): void {
    if (unsaved) this.unsaved.add(windowId);
    else this.unsaved.delete(windowId);
  }

  /** The window has gone; forget everything about it. */
  forget(windowId: number): void {
    this.unsaved.delete(windowId);
    this.agreed.delete(windowId);
    this.pending.delete(windowId);
  }

  /** True when a quit has already been agreed and should not be asked about again. */
  get quitApproved(): boolean {
    return this.quitAgreed;
  }

  /**
   * Whether this window's close must be held back. False when it has nothing unsaved, or when
   * its close has already been agreed.
   */
  shouldHold(windowId: number): boolean {
    return this.unsaved.has(windowId) && !this.agreed.has(windowId);
  }

  /**
   * Asks a window whether it may close, resolving `true` when it agrees. A second ask while one
   * is outstanding resolves `false` — the reader is already looking at the dialog.
   */
  async askWindow(windowId: number, ask: () => void): Promise<boolean> {
    if (this.pending.has(windowId)) return false;
    const answered = new Promise<boolean>((resolve) => {
      this.pending.set(windowId, resolve);
    });
    ask();
    const allowed = await withTimeout(answered, this.timeout, true);
    this.pending.delete(windowId);
    if (allowed) this.agreed.add(windowId);
    return allowed;
  }

  /** The renderer's answer to `askWindow`. */
  answerWindow(windowId: number, allowed: boolean): void {
    const resolve = this.pending.get(windowId);
    this.pending.delete(windowId);
    resolve?.(allowed);
  }

  /** The same for a quit, which one window answers on behalf of the app. */
  async askQuit(ask: () => void): Promise<boolean> {
    if (this.quitAgreed) return true;
    if (this.quitAnswer) return false;
    const answered = new Promise<boolean>((resolve) => {
      this.quitAnswer = resolve;
    });
    ask();
    const allowed = await withTimeout(answered, this.timeout, true);
    this.quitAnswer = null;
    if (allowed) this.quitAgreed = true;
    return allowed;
  }

  answerQuit(allowed: boolean): void {
    const resolve = this.quitAnswer;
    this.quitAnswer = null;
    resolve?.(allowed);
  }

  /** Lets a window through without asking (a tab moved to another window). */
  approve(windowId: number): void {
    this.agreed.add(windowId);
  }
}

/** Resolves with `fallback` if the promise has not settled in time. */
async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      resolve(fallback);
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The bits of a `BrowserWindow` the broker's Electron wiring uses. */
export type ClosableWindow = Pick<BrowserWindow, 'id' | 'close' | 'isDestroyed'>;
