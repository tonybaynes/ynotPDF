/**
 * Shared helpers for the optimise suite (M100): fixtures, a real qpdf, and the two things every
 * acceptance check needs — "is the document still the same document" and "what does a page look
 * like now".
 *
 * The qpdf here is the one the app ships (`src/engine/security/qpdf.ts`); only the factory
 * differs, exactly as M70's suite does it. The engine is M10's real PDFium, so a render
 * comparison is the same render the reader would see.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Qpdf, type QpdfFactory } from '@engine/security/qpdf';
import { QpdfTasks } from '@engine/optimise';
import type { RepairTools, StructureOptions } from '@engine/optimise';
import { dhash, hamming } from '@engine/imageHash';
import { engine, fixture } from '../engine/helpers';

const require_ = createRequire(import.meta.url);

export { fixture, engine, hamming };
export const FIXTURES = join(process.cwd(), 'test', 'fixtures');

let sharedTasks: QpdfTasks | null = null;

/** One qpdf per test process: instantiating the module costs ~40 ms and these tests run many. */
export function tasks(): QpdfTasks {
  sharedTasks ??= new QpdfTasks(
    new Qpdf({ factory: require_('@neslinesli93/qpdf-wasm') as QpdfFactory }),
  );
  return sharedTasks;
}

/** The `structure` hook `optimise()` takes, wired to a real qpdf. */
export function structureHook(): (
  bytes: Uint8Array,
  options: StructureOptions,
) => Promise<{ bytes: Uint8Array; warnings: ReadonlyArray<string> }> {
  return (bytes, options) => tasks().structure(bytes, options);
}

export interface DocumentFacts {
  readonly pages: number;
  readonly sizes: ReadonlyArray<string>;
  readonly text: ReadonlyArray<string>;
}

/** What optimising must never change: how many pages there are, how big they are, what they say. */
export async function factsOf(bytes: Uint8Array): Promise<DocumentFacts> {
  const e = await engine();
  const handle = await e.open(bytes.slice());
  try {
    const pages = await e.pageCount(handle);
    const sizes: string[] = [];
    const text: string[] = [];
    for (let i = 0; i < pages; i++) {
      const size = await e.pageSize(handle, i);
      sizes.push(`${size.width.toFixed(2)}x${size.height.toFixed(2)}`);
      const runs = await e.textRuns(handle, i);
      text.push(
        runs
          .map((r) => r.text)
          .join('')
          .replace(/\s+/g, ' ')
          .trim(),
      );
    }
    return { pages, sizes, text };
  } finally {
    await e.close(handle);
  }
}

/** A perceptual hash per page, at a scale big enough to see a difference and small enough to be quick. */
export async function pageHashes(bytes: Uint8Array, scale = 1): Promise<string[]> {
  const e = await engine();
  const handle = await e.open(bytes.slice());
  try {
    const pages = await e.pageCount(handle);
    const out: string[] = [];
    for (let i = 0; i < pages; i++) {
      const raster = await e.renderRaw(handle, i, scale);
      out.push(dhash(raster.rgba, raster.width, raster.height));
    }
    return out;
  } finally {
    await e.close(handle);
  }
}

export function readFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

/**
 * The two engines a repair uses (ADR 0019 §1a): PDFium through M10's adapter, and qpdf through
 * `QpdfTasks`. The same pair the app wires up, only reached directly rather than through a Worker.
 */
export async function repairTools(): Promise<RepairTools> {
  const e = await engine();
  return {
    reopen: async (bytes) => {
      const handle = await e.open(bytes);
      try {
        return await e.save(handle);
      } finally {
        await e.close(handle);
      }
    },
    rewrite: (bytes) => tasks().repair(bytes),
  };
}
