/**
 * `jpeg-js` returns its bytes as `Buffer.from(...)` whenever it can see a CommonJS `module`
 * object — which a bundled Worker can, because that is how esbuild wraps a CJS dependency — and
 * a browser has no `Buffer`. Without this the encoder throws `Buffer is not defined` on the very
 * last line of a successful encode.
 *
 * So this runs before `jpeg-js` is imported (ES imports evaluate in order) and puts the one
 * method it uses where it looks for it. Node already has the real thing and is left alone. Same
 * trick, same reason, as M91's `create/images/installPako.ts`.
 */

interface BufferLike {
  from(source: ArrayLike<number>): Uint8Array;
}

const scope = globalThis as { Buffer?: BufferLike };

scope.Buffer ??= { from: (source: ArrayLike<number>): Uint8Array => Uint8Array.from(source) };
