/**
 * Licence gate (M00): production dependencies must be permissive. Fails on GPL / AGPL /
 * LGPL-only / commercial / unknown. Uses `license-checker` JSON output.
 * Usage: `node scripts/check-licenses.ts`
 */

import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { packageLicenseOk } from './lib/license-policy.ts';
import {
  bundledPackageDirectories,
  collectBuildInputs,
  writeArtifactInventory,
} from './lib/artifact-inventory.ts';

interface Entry {
  licenses?: string | string[];
  path?: string;
  repository?: string;
  licenseFile?: string;
}

const bin = join(process.cwd(), 'node_modules', 'license-checker', 'bin', 'license-checker');
const json = execFileSync(process.execPath, [bin, '--production', '--json'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const data = JSON.parse(json) as Record<string, Entry>;

const built = process.argv.includes('--built');
const inputs = built ? collectBuildInputs() : [];
if (built) {
  const all = JSON.parse(
    execFileSync(process.execPath, [bin, '--json'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  ) as Record<string, Entry>;
  for (const dir of bundledPackageDirectories(inputs)) {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
    };
    const id = pkg.name + '@' + pkg.version;
    const entry = all[id];
    if (!entry) throw new Error('No licence metadata for bundled package: ' + id);
    data[id] = entry;
  }
}

const root = JSON.parse(readFileSync('package.json', 'utf8')) as {
  name: string;
  version: string;
  private?: boolean;
};
const bad: string[] = [];
let count = 0;
for (const [pkg, entry] of Object.entries(data)) {
  count++;
  const lic = Array.isArray(entry.licenses)
    ? entry.licenses.join(' AND ')
    : (entry.licenses ?? 'UNKNOWN');
  if (
    !packageLicenseOk(pkg, entry.licenses, {
      root: root.name + '@' + root.version,
      privateRoot: root.private === true,
      isRootPath: entry.path !== undefined && resolve(entry.path) === process.cwd(),
    })
  )
    bad.push(`${pkg}: ${lic}`);
}

if (bad.length > 0) {
  console.error(
    `check-licenses: ${bad.length} of ${count} production packages have disallowed licences:`,
  );
  for (const b of bad) console.error(`  ${b}`);
  process.exit(1);
}
console.info(
  `check-licenses: ${count} ${built ? 'runtime/bundled' : 'production'} packages, all permitted by the SPDX policy`,
);
if (built) {
  const packages = Object.fromEntries(
    Object.entries(data).filter(([id]) => id !== root.name + '@' + root.version),
  );
  const problems = writeArtifactInventory(packages, inputs);
  console.info('check-licenses: packaged input/notice inventory written to out/notices');
  if (problems.length) {
    console.warn(
      'Release notice review remains incomplete:\n' + problems.map((p) => '  ' + p).join('\n'),
    );
    if (process.argv.includes('--release')) process.exit(1);
  }
}
