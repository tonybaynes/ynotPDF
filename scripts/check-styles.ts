/**
 * Lint step: colour/opacity rules (see scripts/lib/style-rules.ts). Exit 1 on violations.
 * Usage: `node scripts/check-styles.ts [dir ...]` (defaults to `src`).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { checkSource, formatViolation, type Violation } from './lib/style-rules.ts';

const ROOT = process.cwd();
const EXTENSIONS = new Set(['.css', '.html', '.ts', '.js', '.mjs', '.cjs', '.svg']);
const SKIP_DIRS = new Set(['node_modules', 'out', 'dist', 'release', 'coverage']);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if ([...EXTENSIONS].some((ext) => name.endsWith(ext))) yield full;
  }
}

const dirs = process.argv.slice(2);
if (dirs.length === 0) dirs.push('src');

const violations: Violation[] = [];
let files = 0;
for (const dir of dirs) {
  for (const file of walk(join(ROOT, dir))) {
    files++;
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    violations.push(...checkSource(rel, readFileSync(file, 'utf8')));
  }
}

if (violations.length > 0) {
  console.error(`check-styles: ${violations.length} violation(s) in ${files} files`);
  for (const v of violations) console.error(formatViolation(v));
  process.exit(1);
}
console.info(`check-styles: ${files} files clean`);
