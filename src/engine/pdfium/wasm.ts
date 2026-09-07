/**
 * Loads the PDFium wasm module (M10, ADR 0006).
 *
 * `@hyzyla/pdfium` ships PDFium compiled with emscripten but with a **fixed-size indirect
 * function table** (`min = max`), so no JavaScript function can ever be handed to PDFium as a
 * callback. That rules out `FPDF_SetSystemFontInfo` (our bundled fonts), `FPDF_SaveAsCopy`
 * (needs a `WriteBlock` callback) and `IFSDK_PAUSE` (progressive rendering / cancellation).
 *
 * {@link patchTableLimits} rewrites the one wasm section that declares the table so it has no
 * maximum. The rest of the binary is untouched; the change is structural, verified against the
 * wasm header, and a no-op if the table is already growable. {@link addFunction} is the same
 * trick emscripten's own `addFunction` uses: compile a two-instruction wasm module that imports
 * the JS function and exports it as a wasm function, then store that in a new table slot.
 */

import { PDFiumModule } from '@hyzyla/pdfium';
import type { WasmModule } from './ffi';

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];
const SECTION_TABLE = 4;

function readLeb(bytes: Uint8Array, at: number): { value: number; next: number } {
  let result = 0;
  let shift = 0;
  let p = at;
  for (;;) {
    const c = bytes[p++];
    if (c === undefined) throw new Error('wasm: truncated LEB128');
    result |= (c & 0x7f) << shift;
    shift += 7;
    if ((c & 0x80) === 0) break;
  }
  return { value: result >>> 0, next: p };
}

function writeLeb(value: number): number[] {
  const out: number[] = [];
  let v = value >>> 0;
  do {
    let c = v & 0x7f;
    v >>>= 7;
    if (v !== 0) c |= 0x80;
    out.push(c);
  } while (v !== 0);
  return out;
}

function concat(parts: ReadonlyArray<Uint8Array | number[]>): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Describes the table section of a wasm binary (for tests and diagnostics). */
export function describeTable(bytes: Uint8Array): { min: number; max: number | null } | null {
  let p = 8;
  while (p < bytes.length) {
    const id = bytes[p++];
    const size = readLeb(bytes, p);
    const body = size.next;
    if (id === SECTION_TABLE) {
      const count = readLeb(bytes, body);
      if (count.value !== 1) return null;
      const flags = bytes[count.next + 1] ?? 0;
      const min = readLeb(bytes, count.next + 2);
      const max = (flags & 0x01) !== 0 ? readLeb(bytes, min.next).value : null;
      return { min: min.value, max };
    }
    p = body + size.value;
  }
  return null;
}

/**
 * Returns a copy of `bytes` whose (single) table has no maximum, or `bytes` itself when the
 * table is already unbounded. Throws if the input is not a wasm binary.
 */
export function patchTableLimits(bytes: Uint8Array): Uint8Array {
  for (let i = 0; i < WASM_MAGIC.length; i++) {
    if (bytes[i] !== WASM_MAGIC[i]) throw new Error('patchTableLimits: not a wasm binary');
  }
  let p = 8;
  while (p < bytes.length) {
    const id = bytes[p++];
    const sizeAt = p; // the section-size LEB starts here; bytes[0..sizeAt) includes the id
    const size = readLeb(bytes, p);
    const body = size.next;
    const end = body + size.value;
    if (id === SECTION_TABLE) {
      const count = readLeb(bytes, body);
      if (count.value !== 1) return bytes; // unexpected layout: leave it alone
      const refType = bytes[count.next] ?? 0;
      const flags = bytes[count.next + 1] ?? 0;
      if ((flags & 0x01) === 0) return bytes; // already unbounded
      const minAt = count.next + 2;
      const min = readLeb(bytes, minAt);
      const newBody = [1, refType, 0x00, ...bytes.subarray(minAt, min.next)];
      return concat([
        bytes.subarray(0, sizeAt),
        writeLeb(newBody.length),
        newBody,
        bytes.subarray(end),
      ]);
    }
    p = end;
  }
  return bytes;
}

/** Instantiates PDFium from raw wasm bytes (patched for callbacks) and returns the module. */
export async function instantiatePdfium(wasmBytes: Uint8Array): Promise<WasmModule> {
  const patched = patchTableLimits(wasmBytes);
  const factory = PDFiumModule as unknown as (options: Record<string, unknown>) => Promise<unknown>;
  const module = await factory({
    instantiateWasm: (
      imports: WebAssembly.Imports,
      done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
    ) => {
      void WebAssembly.instantiate(patched as BufferSource, imports).then((r) => {
        done(r.instance, r.module);
      });
      return {};
    },
    print: () => undefined,
    printErr: (line: string) => {
      console.warn(`pdfium: ${line}`);
    },
  });
  return module as WasmModule;
}

/** wasm value types for {@link addFunction} signatures. */
const TYPE_CODES: Record<string, number> = { i: 0x7f, j: 0x7e, f: 0x7d, d: 0x7c };

/**
 * Puts a JS function into the module's indirect function table and returns its index (a C
 * function pointer). `signature` follows emscripten: first character is the return type
 * (`v` void, `i` i32, `j` i64, `f` f32, `d` f64), the rest are parameters, e.g. `'iiii'`.
 */
export function addFunction(
  m: WasmModule,
  fn: (...args: number[]) => number | void,
  signature: string,
): number {
  const ret = signature[0] ?? 'v';
  const params = signature.slice(1);
  const type = [0x60, params.length];
  for (const c of params) {
    const code = TYPE_CODES[c];
    if (code === undefined) throw new Error(`addFunction: bad parameter type ${c}`);
    type.push(code);
  }
  if (ret === 'v') type.push(0);
  else {
    const code = TYPE_CODES[ret];
    if (code === undefined) throw new Error(`addFunction: bad return type ${ret}`);
    type.push(1, code);
  }
  const bytes = new Uint8Array([
    ...WASM_MAGIC,
    0x01,
    0x00,
    0x00,
    0x00, // version
    0x01,
    type.length + 1,
    0x01,
    ...type, // type section: one function type
    0x02,
    0x07,
    0x01,
    0x01,
    0x65,
    0x01,
    0x66,
    0x00,
    0x00, // import "e"."f" as func type 0
    0x07,
    0x05,
    0x01,
    0x01,
    0x66,
    0x00,
    0x00, // export "f" = func 0
  ]);
  const wrapper = new WebAssembly.Instance(new WebAssembly.Module(bytes), { e: { f: fn } });
  const exported = wrapper.exports['f'];
  if (typeof exported !== 'function') throw new Error('addFunction: wrapper export missing');
  const table = m.wasmExports.__indirect_function_table;
  const index = table.grow(1);
  table.set(index, exported);
  return index;
}

/** Frees a table slot created by {@link addFunction}. */
export function removeFunction(m: WasmModule, index: number): void {
  m.wasmExports.__indirect_function_table.set(index, null);
}
