/**
 * jpeg-js needs a global `Buffer`, and a renderer Worker has not got one (M100).
 *
 * The same shape of problem `installPako.ts` solves for utif, and the same answer: put what the
 * library looks for where it looks for it, before it is imported. ES imports evaluate in order,
 * so importing this module above `jpeg-js` is what makes the fix work.
 *
 * jpeg-js reaches for exactly two things — `Buffer.from(arrayOfBytes)` at the end of its encoder
 * and `Buffer.alloc(n)` in its decoder — and both mean "give me a byte array". Under Node the
 * real `Buffer` is already there and this changes nothing (`??=`); in a Worker, a `Uint8Array` is
 * what the callers wanted in the first place, and it is what every one of ours goes on to use.
 *
 * Deliberately *not* a Buffer polyfill. Nothing here needs `toString('base64')`, `readUInt32BE`
 * or any of the rest, and shipping a 50 kB shim to satisfy two calls would be the wrong trade.
 * A future library that wants more will fail loudly on the method it wanted rather than quietly
 * on the wrong bytes.
 */

interface MinimalBuffer {
  from(value: ArrayLike<number> | ArrayBufferLike): Uint8Array;
  alloc(size: number): Uint8Array;
}

const scope = globalThis as { Buffer?: MinimalBuffer };

scope.Buffer ??= {
  from: (value) =>
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : Uint8Array.from(value as ArrayLike<number>),
  alloc: (size) => new Uint8Array(Math.max(0, size)),
};
