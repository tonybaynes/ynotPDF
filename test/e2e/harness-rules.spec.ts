/**
 * Rules the harness enforces about how tests open documents (M04).
 *
 * These read files and start no app, so they cost milliseconds.
 *
 * The rule here exists because the trap it closes went off twice before anyone saw the shape of
 * it. A document opened by its bytes still needs a path — that is how the app identifies a
 * document — and M11 remembers *where the reader left a document* by that path. A spec whose
 * open helper defaults to `C:/fixtures/<name>` therefore gives every test that opens
 * `multipage.pdf` the same document identity, and the second test starts wherever the first one
 * finished. It read as a flaky test on macOS; it was neither flaky nor macOS, and M60 reproduced
 * it on Windows in a single run (2026-09-11).
 *
 * Sharing a path deliberately is fine and `viewer.spec.ts` does it on purpose, to prove the
 * reader comes back to where they left a document. Ask for it with an explicit path. What this
 * rule forbids is sharing nobody asked for.
 */

import { expect, test } from '@playwright/test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const E2E = join(process.cwd(), 'test', 'e2e');

/** Every `*.spec.ts` under `test/e2e`, including the journeys. */
function specs(dir: string = E2E): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...specs(full));
    else if (entry.name.endsWith('.spec.ts')) found.push(full);
  }
  return found;
}

test('no spec builds a document path out of a bare fixture name', () => {
  // `C:/fixtures/${name}` — the same path for every test that opens the same fixture.
  const shared = /`[^`]*\/\$\{\s*name\s*\}`/;
  const offenders: string[] = [];
  for (const file of specs()) {
    // This file has to be able to write the pattern down in order to forbid it.
    if (file.endsWith('harness-rules.spec.ts')) continue;
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (!shared.test(line)) return;
        offenders.push(`${file.slice(E2E.length + 1).replace(/\\/g, '/')}:${String(i + 1)}`);
      });
  }
  expect(
    offenders,
    'these lines give every test that opens the same fixture the same document identity, so ' +
      'one test starts where another finished:\n' +
      `${offenders.join('\n')}\n` +
      'Use `fixturePath(name)` from the harness, which is a fresh path each call. If a test ' +
      'means to share one — to prove the reader comes back to where they left off — pass an ' +
      'explicit path and it is obvious that it was asked for.',
  ).toEqual([]);
});
