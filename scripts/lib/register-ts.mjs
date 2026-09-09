/**
 * Lets a script under `scripts/` import the app's own TypeScript (M31).
 *
 * Node strips types on its own, but it resolves imports by the letter: `./content` does not find
 * `./content.ts`, and every file under `src/` imports its neighbours without an extension because
 * Vite resolves them at build time. This hook tries `.ts` and `/index.ts` when a relative import
 * is not found, and nothing else — an alias like `@shared/pdf` is still only usable as a type.
 *
 * Usage: `node --import ./scripts/lib/register-ts.mjs scripts/make-stamps.ts`.
 */

import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error;
      for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
        try {
          return next(candidate, context);
        } catch {
          // try the next form
        }
      }
      throw error;
    }
  },
});
