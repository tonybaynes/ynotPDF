/**
 * Thin FFI helpers over the emscripten module that hosts PDFium (M10).
 *
 * PDFium's C API is called directly through the `_FPDF*` exports. This file owns the
 * uncomfortable parts: heap allocation, UTF-8/UTF-16 strings, struct reads, and the "call twice
 * to learn the buffer size" pattern PDFium uses for every string getter.
 *
 * Never cache a `HEAP*` view across a call that may allocate — wasm memory can grow and the
 * module swaps the views. Always read them fresh from the module.
 */

/** The subset of the emscripten `Module` object we rely on. */
export interface WasmModule {
  readonly HEAP8: Int8Array;
  readonly HEAPU8: Uint8Array;
  readonly HEAP16: Int16Array;
  readonly HEAPU16: Uint16Array;
  readonly HEAP32: Int32Array;
  readonly HEAPU32: Uint32Array;
  readonly HEAPF32: Float32Array;
  readonly HEAPF64: Float64Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  readonly wasmExports: { readonly __indirect_function_table: WebAssembly.Table };
}

/** A C function exported by the wasm module. All wasm32 scalars arrive as JS numbers. */
export type CFn = (...args: number[]) => number;

/** Allocations made through a scope are freed together when the scope ends. */
export class Scope {
  private readonly ptrs: number[] = [];
  private readonly ffi: Ffi;
  constructor(ffi: Ffi) {
    this.ffi = ffi;
  }

  /** Zeroed allocation of `size` bytes. */
  alloc(size: number): number {
    const p = this.ffi.malloc(Math.max(1, size));
    this.ffi.m.HEAPU8.fill(0, p, p + Math.max(1, size));
    this.ptrs.push(p);
    return p;
  }

  /** Copies `bytes` into wasm memory. */
  bytes(bytes: Uint8Array): number {
    const p = this.ffi.malloc(Math.max(1, bytes.byteLength));
    this.ffi.m.HEAPU8.set(bytes, p);
    this.ptrs.push(p);
    return p;
  }

  /** NUL-terminated UTF-8 string. */
  utf8(text: string): number {
    return this.bytes(Ffi.encodeUtf8Z(text));
  }

  /** NUL-terminated UTF-16LE string (what `FPDF_WIDESTRING` expects). */
  utf16(text: string): number {
    const buf = new Uint8Array((text.length + 1) * 2);
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      buf[i * 2] = c & 0xff;
      buf[i * 2 + 1] = c >> 8;
    }
    return this.bytes(buf);
  }

  release(): void {
    for (const p of this.ptrs) this.ffi.free(p);
    this.ptrs.length = 0;
  }
}

export class Ffi {
  private readonly fns = new Map<string, CFn>();
  private static readonly utf8Encoder = new TextEncoder();
  private static readonly utf8Decoder = new TextDecoder('utf-8');
  private static readonly utf16Decoder = new TextDecoder('utf-16le');
  readonly m: WasmModule;

  constructor(m: WasmModule) {
    this.m = m;
  }

  /** Looks up `_${name}` on the module. Throws when the build lacks the export. */
  fn(name: string): CFn {
    let f = this.fns.get(name);
    if (!f) {
      const candidate = (this.m as unknown as Record<string, unknown>)[`_${name}`];
      if (typeof candidate !== 'function') {
        throw new Error(`PDFium export ${name} is missing from this wasm build`);
      }
      f = candidate as CFn;
      this.fns.set(name, f);
    }
    return f;
  }

  /** Whether the build exports `name`. */
  has(name: string): boolean {
    return typeof (this.m as unknown as Record<string, unknown>)[`_${name}`] === 'function';
  }

  call(name: string, ...args: number[]): number {
    return this.fn(name)(...args);
  }

  malloc(size: number): number {
    const p = this.m._malloc(size);
    if (p === 0) throw new Error(`PDFium: out of wasm memory allocating ${size} bytes`);
    return p;
  }

  free(ptr: number): void {
    if (ptr !== 0) this.m._free(ptr);
  }

  /** Runs `fn` with a scope; every scoped allocation is freed afterwards (also on throw). */
  scope<T>(fn: (s: Scope) => T): T {
    const s = new Scope(this);
    try {
      return fn(s);
    } finally {
      s.release();
    }
  }

  // ---- struct / scalar access --------------------------------------------------------------

  i32(ptr: number, index = 0): number {
    return this.m.HEAP32[(ptr >> 2) + index] ?? 0;
  }
  u32(ptr: number, index = 0): number {
    return this.m.HEAPU32[(ptr >> 2) + index] ?? 0;
  }
  u16(ptr: number, index = 0): number {
    return this.m.HEAPU16[(ptr >> 1) + index] ?? 0;
  }
  u8(ptr: number, index = 0): number {
    return this.m.HEAPU8[ptr + index] ?? 0;
  }
  f32(ptr: number, index = 0): number {
    return this.m.HEAPF32[(ptr >> 2) + index] ?? 0;
  }
  f64(ptr: number, index = 0): number {
    return this.m.HEAPF64[(ptr >> 3) + index] ?? 0;
  }
  setI32(ptr: number, value: number, index = 0): void {
    this.m.HEAP32[(ptr >> 2) + index] = value;
  }
  setU32(ptr: number, value: number, index = 0): void {
    this.m.HEAPU32[(ptr >> 2) + index] = value;
  }
  setF32(ptr: number, value: number, index = 0): void {
    this.m.HEAPF32[(ptr >> 2) + index] = value;
  }
  setF64(ptr: number, value: number, index = 0): void {
    this.m.HEAPF64[(ptr >> 3) + index] = value;
  }

  /** Copies `length` bytes out of wasm memory into a fresh buffer. */
  copyBytes(ptr: number, length: number): Uint8Array {
    return this.m.HEAPU8.slice(ptr, ptr + length);
  }

  // ---- strings -----------------------------------------------------------------------------

  static encodeUtf8Z(text: string): Uint8Array {
    const enc = Ffi.utf8Encoder.encode(text);
    const out = new Uint8Array(enc.length + 1);
    out.set(enc);
    return out;
  }

  /** Reads a NUL-terminated (or `length`-bounded) UTF-8 string. */
  readUtf8(ptr: number, length?: number): string {
    if (ptr === 0) return '';
    const heap = this.m.HEAPU8;
    let end = ptr;
    const max = length === undefined ? heap.length : ptr + length;
    while (end < max && heap[end] !== 0) end++;
    return Ffi.utf8Decoder.decode(heap.subarray(ptr, end));
  }

  /** Reads `byteLength` bytes of UTF-16LE, dropping a trailing NUL. */
  readUtf16(ptr: number, byteLength: number): string {
    if (ptr === 0 || byteLength <= 0) return '';
    let end = ptr + (byteLength & ~1);
    const heap = this.m.HEAPU8;
    while (end - 2 >= ptr && heap[end - 2] === 0 && heap[end - 1] === 0) end -= 2;
    return Ffi.utf16Decoder.decode(heap.subarray(ptr, end));
  }

  /**
   * PDFium string getter pattern for `FPDF_WIDESTRING` outputs: call with a null buffer to get
   * the byte length (including the NUL), allocate, call again. `f(buffer, byteLength)` must
   * return the number of bytes written/needed.
   */
  utf16Call(f: (buffer: number, byteLength: number) => number): string {
    const needed = f(0, 0);
    if (needed <= 2) return '';
    return this.scope((s) => {
      const buf = s.alloc(needed);
      const written = f(buf, needed);
      return this.readUtf16(buf, Math.min(written, needed));
    });
  }

  /** Same pattern for UTF-8 (`char*`) outputs that report the length including the NUL. */
  utf8Call(f: (buffer: number, length: number) => number): string {
    const needed = f(0, 0);
    if (needed <= 1) return '';
    return this.scope((s) => {
      const buf = s.alloc(needed);
      const written = f(buf, needed);
      return this.readUtf8(buf, Math.max(0, Math.min(written, needed) - 1));
    });
  }

  /** Same pattern for raw byte outputs (attachments, XMP): returns a copy owned by the caller. */
  bytesCall(f: (buffer: number, length: number) => number): Uint8Array {
    const needed = f(0, 0);
    if (needed <= 0) return new Uint8Array(0);
    return this.scope((s) => {
      const buf = s.alloc(needed);
      const written = f(buf, needed);
      return this.copyBytes(buf, Math.min(written, needed));
    });
  }
}

/** PDF/PDFium `FS_RECTF` is `left, top, right, bottom` floats. Reads one in page space. */
export function readRectF(
  ffi: Ffi,
  ptr: number,
): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  return {
    left: ffi.f32(ptr, 0),
    top: ffi.f32(ptr, 1),
    right: ffi.f32(ptr, 2),
    bottom: ffi.f32(ptr, 3),
  };
}

/** `FS_MATRIX` is `a b c d e f` floats. */
export function readMatrix(
  ffi: Ffi,
  ptr: number,
): readonly [number, number, number, number, number, number] {
  return [
    ffi.f32(ptr, 0),
    ffi.f32(ptr, 1),
    ffi.f32(ptr, 2),
    ffi.f32(ptr, 3),
    ffi.f32(ptr, 4),
    ffi.f32(ptr, 5),
  ];
}
