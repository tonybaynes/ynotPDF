import { describe, expect, it } from 'vitest';
import {
  addFunction,
  describeTable,
  instantiatePdfium,
  patchTableLimits,
  removeFunction,
} from '@engine/pdfium/wasm';
import { loadWasm } from './helpers';

describe('wasm table patch', () => {
  it('turns the fixed-size table into a growable one and nothing else', () => {
    const original = loadWasm();
    const before = describeTable(original);
    expect(before).not.toBeNull();
    expect(before?.max).toBe(before?.min); // the shipped build cannot grow
    const patched = patchTableLimits(original);
    const after = describeTable(patched);
    expect(after).toEqual({ min: before?.min, max: null });
    expect(patched.length).toBe(original.length - 2); // dropped the 2-byte max, same section
    expect(patchTableLimits(patched)).toBe(patched); // idempotent: already unbounded
    expect(() => patchTableLimits(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/not a wasm/);
    // Both binaries compile: the patch keeps the module valid.
    expect(WebAssembly.validate(patched as BufferSource)).toBe(true);
  });

  it('adds and removes JS callbacks through the table', async () => {
    const m = await instantiatePdfium(loadWasm());
    const table = m.wasmExports.__indirect_function_table;
    const before = table.length;
    const seen: number[] = [];
    const idx = addFunction(
      m,
      (a: number, b: number) => {
        seen.push(a, b);
        return a * b;
      },
      'iii',
    );
    expect(idx).toBe(before);
    expect(table.length).toBe(before + 1);
    const fn = table.get(idx) as (a: number, b: number) => number;
    expect(fn(6, 7)).toBe(42);
    expect(seen).toEqual([6, 7]);
    const voidIdx = addFunction(m, () => undefined, 'vi');
    const voidFn = table.get(voidIdx) as (x: number) => void;
    expect(() => {
      voidFn(1);
    }).not.toThrow();
    removeFunction(m, idx);
    expect(table.get(idx)).toBeNull();
    expect(() => addFunction(m, () => 0, 'ix')).toThrow(/bad parameter/);
  });
});
