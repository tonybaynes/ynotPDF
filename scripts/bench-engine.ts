/**
 * Runs the engine benchmarks (`test/unit/engine/bench.test.ts`) through vitest so the engine
 * source (path aliases, TypeScript) loads the same way as in tests. Results print as a
 * Markdown table and land in `docs/bench/engine-<platform>-<arch>.json`.
 *
 * Usage: `npm run bench`
 */

import { spawnSync } from 'node:child_process';

const result = spawnSync(
  'npx',
  ['vitest', 'run', 'test/unit/engine/bench.test.ts', '--coverage.enabled=false', '--silent=false'],
  { stdio: 'inherit', shell: true, env: { ...process.env, YNOT_BENCH: '1' } },
);
process.exit(result.status ?? 1);
