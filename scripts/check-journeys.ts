/**
 * Advisory check (M04): which end-to-end specs never touch a journey helper.
 *
 * The rule this backs is in `test/README.md`: **a feature is not covered until a test reaches
 * it the way a person does.** A spec that only calls `app.run(...)` is asserting that commands
 * work, which is worth knowing and is not the same thing.
 *
 * It **warns and exits 0, always.** A spec with no journey in it is sometimes exactly right —
 * the engine specs, the arithmetic — and a rule that fails the build over a judgement call gets
 * deleted within a month, at which point it catches nothing. On a pull request the warning is
 * the conversation; the reviewer decides.
 *
 * Usage: `node scripts/check-journeys.ts`
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const E2E = join(ROOT, 'test', 'e2e');

/** The helpers that mean "this spec drives the UI". */
const HELPERS = [
  'journey(',
  'clickRibbon(',
  'clickPanelTile(',
  'openPanel(',
  'clickPage(',
  'clickPageAt(',
  'dragOnPage(',
  'dragOnPageAt(',
  'dragElement(',
  'clickHere(',
  'answerIdentityIfAsked(',
  'expectNothingClipped(',
  'expectInsideWindow(',
  'expectNoOverlap(',
  'expectReadable(',
  'expectWindowSound(',
];

function* specs(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* specs(full);
    else if (name.endsWith('.spec.ts')) yield full;
  }
}

const without: string[] = [];
let total = 0;
for (const file of specs(E2E)) {
  total++;
  const source = readFileSync(file, 'utf8');
  if (HELPERS.some((helper) => source.includes(helper))) continue;
  without.push(relative(ROOT, file).replaceAll(sep, '/'));
}

if (without.length === 0) {
  console.info(`check-journeys: all ${String(total)} e2e specs use a journey or layout helper.`);
} else {
  console.warn(
    `check-journeys: ${String(without.length)} of ${String(total)} e2e specs use no journey or ` +
      'layout helper. A feature is not covered until a test reaches it the way a person does — ' +
      'see test/README.md. This is a warning, not a failure.',
  );
  for (const file of without) console.warn(`  ${file}`);
}
