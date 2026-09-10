/**
 * jpeg-js needs a global `Buffer`, and a renderer Worker has not got one (M100).
 *
 * The same shape of problem `installPako.ts` solves for utif, and the same answer: put what the
 * library looks for where it looks for it, before it is imported. ES imports evaluate in order,
 * so importing this module above `jpeg-js` is what makes the fix work.
 *
 * jpeg-js reaches for exactly two things — `Buffer.from(arrayOfBytes)` at the end of its encoder
 * and `Buffer.alloc(n)` in its decoder — and both mean "give me a byte array". Under Node the
 * real `Buffer` is already there; in a Worker, a `Uint8Array` is what the callers wanted in the
 * first place, and it is what every one of ours goes on to use.
 *
 * **Each method is filled in on its own, rather than the object as a whole.** M92 installs a
 * shim of its own for the same library (`src/engine/export/codecs/installBuffer.ts`) carrying
 * only `from`; two modules doing `globalThis.Buffer ??= {…}` means whichever bundle happens to
 * load first decides what the other one gets, and a decoder that then asks for `alloc` fails a
 * long way from here. Filling the gaps leaves whatever is already there alone and makes the load
 * order stop mattering.
 *
 * Deliberately *not* a Buffer polyfill. Nothing here needs `toString('base64')`, `readUInt32BE`
 * or any of the rest, and shipping a 50 kB shim to satisfy two calls would be the wrong trade.
 * A future library that wants more will fail loudly on the method it wanted rather than quietly
 * on the wrong bytes.
 */

/**
 * Properties rather than methods: jpeg-js calls `Buffer.from(…)` off the object it finds on the
 * global, never off a `this` of its own, and declaring them as methods makes the lint rule about
 * unbound `this` fire on every assignment below for a `this` nothing here has.
 */
interface MinimalBuffer {
  from?: (value: ArrayLike<number> | ArrayBufferLike) => Uint8Array;
  alloc?: (size: number) => Uint8Array;
}

// A side-effect module with nothing to export is a *script* to TypeScript, and a script's
// top-level names are global — so this file and M92's would collide on `scope` and on their two
// different ideas of what `Buffer.from` accepts. The empty export makes it a module.
export {};

const scope = globalThis as { Buffer?: MinimalBuffer };

scope.Buffer ??= {};
scope.Buffer.from ??= (value) =>
  value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : Uint8Array.from(value as ArrayLike<number>);
scope.Buffer.alloc ??= (size) => new Uint8Array(Math.max(0, size));
