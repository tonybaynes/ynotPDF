/**
 * Licence gate (M00): production dependencies must be permissive. Fails on GPL / AGPL /
 * LGPL-only / commercial / unknown. Uses `license-checker` JSON output.
 * Usage: `node scripts/check-licenses.ts`
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  'BSD',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Apache-2.0',
  'Apache 2.0',
  'CC0-1.0',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'Unlicense',
  'Python-2.0',
  'BlueOak-1.0.0',
  'MPL-2.0',
  'WTFPL',
  'Zlib',
  'Artistic-2.0',
  'UNLICENSED', // this package itself (private)
]);

const FORBIDDEN = /\b(A?GPL|LGPL|SSPL|EUPL|OSL|CPAL|Commercial|Proprietary)\b/i;

interface Entry {
  licenses?: string | string[];
  repository?: string;
  licenseFile?: string;
}

const bin = join(process.cwd(), 'node_modules', 'license-checker', 'bin', 'license-checker');
const json = execFileSync(process.execPath, [bin, '--production', '--json'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const data = JSON.parse(json) as Record<string, Entry>;

function licenseOk(expr: string): boolean {
  // Handles "MIT", "(MIT OR Apache-2.0)", "MIT AND Zlib", "BSD*".
  const cleaned = expr.replace(/[()*]/g, '').trim();
  if (FORBIDDEN.test(cleaned) && !/\bOR\b/.test(cleaned)) return false;
  const parts = cleaned.split(/\s+(?:OR|AND)\s+/i).map((p) => p.trim());
  if (/\bOR\b/i.test(cleaned)) return parts.some((p) => ALLOWED.has(p));
  return parts.every((p) => ALLOWED.has(p));
}

const bad: string[] = [];
let count = 0;
for (const [pkg, entry] of Object.entries(data)) {
  count++;
  const lic = Array.isArray(entry.licenses)
    ? entry.licenses.join(' OR ')
    : (entry.licenses ?? 'UNKNOWN');
  if (!licenseOk(lic)) bad.push(`${pkg}: ${lic}`);
}

if (bad.length > 0) {
  console.error(
    `check-licenses: ${bad.length} of ${count} production packages have disallowed licences:`,
  );
  for (const b of bad) console.error(`  ${b}`);
  process.exit(1);
}
console.info(`check-licenses: ${count} production packages, all permissive`);
