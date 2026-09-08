/**
 * The performance HUD (M11) — developer builds only.
 *
 * Shows the three numbers that actually tell you whether the viewer is behaving: frames per
 * second, tile throughput with the cache hit rate, and the worker queue depth. It is what the
 * 500-page scroll acceptance test reads, so it is a real instrument rather than a debug print:
 * `sample()` is exposed for Playwright and the numbers it returns are the ones on screen.
 *
 * Status is a word plus a number, never a colour on its own — a slow frame rate says "slow".
 */

import { el } from '@app/dom';
import type { TileRenderer } from './TileRenderer';

export interface PerfSample {
  readonly fps: number;
  /** Mean frame time in ms over the window. */
  readonly frameMs: number;
  /** Worst frame time in the window. */
  readonly worstMs: number;
  readonly tilesPerSecond: number;
  readonly cacheHitRate: number;
  readonly cacheMb: number;
  readonly cacheMaxMb: number;
  readonly queued: number;
  readonly inFlight: number;
  readonly frames: number;
  /** Tiles the engine has rendered since the last `reset()`. */
  readonly rendered: number;
  readonly cancelled: number;
}

/** Below this the HUD says so in words. */
export const SLOW_FPS = 55;

export class PerfHud {
  readonly element: HTMLElement;
  private readonly renderer: TileRenderer;
  private readonly times: number[] = [];
  private raf = 0;
  private running = false;
  private last = 0;
  private renderedAtReset = 0;
  private cancelledAtReset = 0;

  constructor(renderer: TileRenderer) {
    this.renderer = renderer;
    this.element = el('div.viewer-hud', {
      role: 'status',
      'aria-live': 'off',
      'aria-label': 'Viewer performance',
    });
  }

  get visible(): boolean {
    return this.running;
  }

  /** Attaches to a host and starts sampling. */
  start(host: HTMLElement): void {
    if (this.running) return;
    this.running = true;
    host.append(this.element);
    this.last = performance.now();
    const tick = (now: number): void => {
      if (!this.running) return;
      const dt = now - this.last;
      this.last = now;
      if (dt > 0 && dt < 2000) this.times.push(dt);
      // Keep roughly two seconds of history.
      while (this.times.length > 120) this.times.shift();
      this.render();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.element.remove();
  }

  toggle(host: HTMLElement): boolean {
    if (this.running) this.stop();
    else this.start(host);
    return this.running;
  }

  /** Clears the frame history — the test calls this before the scroll it is measuring. */
  reset(): void {
    this.times.length = 0;
    this.renderer.cache.resetStats();
    const stats = this.renderer.stats();
    this.renderedAtReset = stats.rendered;
    this.cancelledAtReset = stats.cancelled;
    this.last = performance.now();
  }

  sample(): PerfSample {
    const stats = this.renderer.stats();
    const frames = this.times.length;
    const total = this.times.reduce((a, b) => a + b, 0);
    const frameMs = frames === 0 ? 0 : total / frames;
    const worstMs = frames === 0 ? 0 : Math.max(...this.times);
    return {
      fps: frameMs > 0 ? 1000 / frameMs : 0,
      frameMs,
      worstMs,
      tilesPerSecond: stats.tilesPerSecond,
      cacheHitRate: stats.cacheHitRate,
      cacheMb: stats.cacheBytes / (1024 * 1024),
      cacheMaxMb: stats.cacheMaxBytes / (1024 * 1024),
      queued: stats.queued,
      inFlight: stats.inFlight,
      frames,
      rendered: stats.rendered - this.renderedAtReset,
      cancelled: stats.cancelled - this.cancelledAtReset,
    };
  }

  private render(): void {
    const s = this.sample();
    const slow = s.frames > 10 && s.fps < SLOW_FPS;
    const rows: HTMLElement[] = [
      el(
        'div',
        null,
        `${s.fps.toFixed(0).padStart(3)} fps  ${s.frameMs.toFixed(1)} ms avg  ${s.worstMs.toFixed(1)} ms worst`,
      ),
      el(
        'div',
        null,
        `${String(s.tilesPerSecond).padStart(3)} tiles/s  ${(s.cacheHitRate * 100).toFixed(0)}% hits`,
      ),
      el(
        'div',
        null,
        `cache ${s.cacheMb.toFixed(0)}/${s.cacheMaxMb.toFixed(0)} MB  queue ${s.queued}+${s.inFlight}`,
      ),
    ];
    if (slow) rows.push(el('div.viewer-hud-warn', null, 'slow — below 55 fps'));
    this.element.replaceChildren(...rows);
  }
}
