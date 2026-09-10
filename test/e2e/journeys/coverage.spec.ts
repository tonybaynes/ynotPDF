/**
 * The rule, enforced (M04).
 *
 * **Every merged module has at least one journey test.** A module is merged when its row in
 * `PLAN.md` §0 is ticked; a journey is a test in this folder whose title names the module. This
 * file reads both and says which module is missing one, so the acceptance line
 *
 *   > Every merged module has at least one journey test that uses no `app.run` for the action
 *   > under test
 *
 * cannot quietly stop being true as modules land. It reads files and starts no app.
 */

import { expect, test } from '@playwright/test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const JOURNEYS = join(ROOT, 'test', 'e2e', 'journeys');

/** Module ids whose row in PLAN.md §0 is ticked. */
function mergedModules(): string[] {
  const plan = readFileSync(join(ROOT, 'PLAN.md'), 'utf8');
  const ids: string[] = [];
  for (const line of plan.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    if (!line.includes('☑')) continue;
    const id = /\|\s*(M\d+)\s/.exec(line)?.[1];
    if (id) ids.push(id);
  }
  return ids;
}

/** Every test title in `test/e2e/journeys`. */
function journeyTitles(): string[] {
  const titles: string[] = [];
  for (const name of readdirSync(JOURNEYS)) {
    if (!name.endsWith('.spec.ts')) continue;
    const source = readFileSync(join(JOURNEYS, name), 'utf8');
    for (const match of source.matchAll(/^test\(\s*(['"`])([\s\S]*?)\1/gm)) {
      titles.push(match[2] ?? '');
    }
  }
  return titles;
}

test('every merged module has a journey named after it', () => {
  const merged = mergedModules();
  expect(
    merged.length,
    'PLAN.md §0 lists no merged modules — has the table changed?',
  ).toBeGreaterThan(10);
  const titles = journeyTitles();
  expect(titles.length, 'no journey tests found').toBeGreaterThan(10);
  const covered = (id: string): boolean =>
    titles.some((t) => new RegExp(`(^|[^0-9A-Za-z])${id}([^0-9]|$)`).test(t));
  // M04 is the harness itself: every file in this folder is its journey.
  const missing = merged.filter((id) => id !== 'M04' && !covered(id));
  expect(
    missing,
    `these modules are merged but no journey names them: ${missing.join(', ')}. ` +
      'A feature is not covered until a test reaches it the way a person does — ' +
      'add a test to test/e2e/journeys whose title starts with the module id.',
  ).toEqual([]);
});

test('no journey drives the action under test through app.run', () => {
  // `app.run` is allowed for setup — opening a file, seeding an identity, reading state back
  // through a `dev.*` command. It is not allowed for the thing the journey is about, and the
  // giveaway is a bare feature command: `annot.`, `draw.`, `organize.`, `view.`, and so on.
  const offenders: string[] = [];
  const allowed =
    /^(file\.openBytes|file\.closeAll|app\.tabs\.closeAll|annot\.identity|annot\.deselect|annot\.selectAll|dev\.[\w.]+|view\.pane\.right\.toggle|draw\.stampCustom)$/;
  for (const name of readdirSync(JOURNEYS)) {
    if (!name.endsWith('.spec.ts')) continue;
    const source = readFileSync(join(JOURNEYS, name), 'utf8');
    source.split(/\r?\n/).forEach((line, i) => {
      const call = /\.run\(\s*(['"`])([^'"`]+)\1/.exec(line);
      if (!call) return;
      const id = call[2] ?? '';
      if (allowed.test(id)) return;
      offenders.push(`${name}:${String(i + 1)} runs "${id}"`);
    });
  }
  expect(
    offenders,
    `a journey drives a feature command directly:\n${offenders.join('\n')}\n` +
      'Press the button a person presses, or add the command to the setup allow-list above ' +
      'with a reason.',
  ).toEqual([]);
});
