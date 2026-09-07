/**
 * Regenerates `test/fixtures/hashes/<platform>.json` from the current engine output by running
 * the corpus test in "update" mode. Use after an intentional rendering change (new PDFium,
 * new fonts, fixture edits). Review the diff before committing.
 *
 * Usage: `npm run hashes`
 */

import { spawnSync } from 'node:child_process';

const result = spawnSync(
  'npx',
  [
    'vitest',
    'run',
    'test/unit/engine/corpus.test.ts',
    '--coverage.enabled=false',
    '--silent=false',
  ],
  { stdio: 'inherit', shell: true, env: { ...process.env, YNOT_UPDATE_HASHES: '1' } },
);
process.exit(result.status ?? 1);
