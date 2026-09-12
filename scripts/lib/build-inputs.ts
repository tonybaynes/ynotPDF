/** Record actual application/worker build inputs for the packaged licence gate. */
import { createHash } from 'node:crypto';
import { relative, resolve } from 'node:path';
import type { Plugin } from 'vite';

export function buildInputs(scope: 'main' | 'preload' | 'renderer' | 'worker'): Plugin {
  const root = process.cwd();
  return {
    name: 'ynot-build-inputs',
    generateBundle() {
      const inputs = [...this.getModuleIds()]
        .filter((id) => !id.includes('\0'))
        .map((id) => relative(root, resolve(id.split('?')[0] ?? id)).replaceAll('\\', '/'))
        .filter((id) => !id.startsWith('../') && id !== '')
        .sort();
      const source = JSON.stringify({ version: 1, scope, inputs }, null, 2) + '\n';
      const hash = createHash('sha256').update(source).digest('hex').slice(0, 12);
      this.emitFile({ type: 'asset', fileName: `licenses/inputs-${scope}-${hash}.json`, source });
    },
  };
}
