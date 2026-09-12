/** Build-input coverage and distribution notice accounting, separate from SPDX policy. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

export interface LicenseEntry {
  licenses?: string | string[];
  path?: string;
  repository?: string;
  licenseFile?: string;
}
export interface ArtifactReview {
  id: string;
  package: string;
  version: string;
  file: string;
  sha256: string;
  source: string;
  provenance: string;
  reviewComplete: boolean;
  notices: string[];
  openItems: string[];
}
function hash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
function walk(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
export function bundledPackageDirectories(inputs: ReadonlyArray<string>): string[] {
  const dirs = new Set<string>();
  for (const input of inputs) {
    // npm can nest a different dependency version; retain the complete package path.
    const match = /^(.*node_modules\/)(@[^/]+\/[^/]+|[^/]+)/.exec(input.replaceAll('\\', '/'));
    if (match) dirs.add((match[1] ?? '') + (match[2] ?? ''));
  }
  return [...dirs].sort();
}
export function collectBuildInputs(): string[] {
  const scopes = new Set<string>();
  const inputs = new Set<string>();
  for (const dir of ['out/main', 'out/preload', 'out/renderer']) {
    if (!existsSync(dir)) throw new Error('Build the application before checking its inventory');
    const manifests = walk(dir).filter((path) => /^inputs-.*\.json$/.test(basename(path)));
    if (!manifests.length) throw new Error('Missing build input manifests in ' + dir);
    for (const path of manifests) {
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
        version?: number;
        scope?: string;
        inputs?: unknown;
      };
      if (
        manifest.version !== 1 ||
        typeof manifest.scope !== 'string' ||
        !Array.isArray(manifest.inputs)
      )
        throw new Error('Invalid build input manifest: ' + path);
      scopes.add(manifest.scope);
      for (const input of manifest.inputs) {
        if (typeof input !== 'string' || input.startsWith('../') || resolve(input) === input)
          throw new Error('Invalid build input path');
        inputs.add(input);
      }
    }
  }
  for (const scope of ['main', 'preload', 'renderer', 'worker'])
    if (!scopes.has(scope)) throw new Error('Missing build input scope: ' + scope);
  return [...inputs].sort();
}
export function verifyArtifactReview(review: ArtifactReview): void {
  const pkg = JSON.parse(
    readFileSync(join('node_modules', review.package, 'package.json'), 'utf8'),
  ) as { version: string };
  if (pkg.version !== review.version || hash(review.file) !== review.sha256)
    throw new Error('Artifact changed; refresh its provenance/notice review: ' + review.id);
}
export function releaseProblems(
  components: ReadonlyArray<{ id: string; completeNotice: boolean }>,
  artifacts: ReadonlyArray<ArtifactReview>,
): string[] {
  return [
    ...components
      .filter((entry) => !entry.completeNotice)
      .map((entry) => entry.id + ': complete licence notice not verified'),
    ...artifacts
      .filter((entry) => !entry.reviewComplete || entry.openItems.length || !entry.notices.length)
      .map((entry) => entry.id + ': compiled-component/notice review is incomplete'),
  ];
}

export function writeArtifactInventory(
  packages: Readonly<Record<string, LicenseEntry>>,
  inputs: ReadonlyArray<string>,
): string[] {
  const notices: string[] = [];
  const components: {
    id: string;
    license: string | string[];
    completeNotice: boolean;
    noticeSha256: string | null;
  }[] = [];
  for (const [id, entry] of Object.entries(packages).sort(([a], [b]) => a.localeCompare(b))) {
    const notice = entry.licenseFile;
    // license-checker may return a README containing only the word "MIT" or "ISC".
    // That is useful metadata, but not a verified redistribution notice.
    const completeNotice =
      notice !== undefined && /^(licen[sc]e|copying|notice)/i.test(basename(notice));
    components.push({
      id,
      license: entry.licenses ?? 'UNKNOWN',
      completeNotice,
      noticeSha256: notice && existsSync(notice) ? hash(notice) : null,
    });
    if (notice && existsSync(notice))
      notices.push(id + '\n' + (entry.repository ?? '') + '\n\n' + readFileSync(notice, 'utf8'));
  }
  const binaryManifest = JSON.parse(readFileSync('resources/binaries.json', 'utf8')) as {
    binaries: {
      name: string;
      version: string;
      dir?: string;
      targets: Record<
        string,
        {
          url: string;
          sha256: string;
          extract?: { files: Record<string, string> };
        }
      >;
    }[];
  };
  const knownResources = new Set<string>();
  const downloadReviews = (
    JSON.parse(readFileSync('resources/licenses/downloads.json', 'utf8')) as {
      downloads: {
        name: string;
        version: string;
        license: string;
        archives: string[];
        files: Record<string, string>;
      }[];
    }
  ).downloads;
  const downloaded = binaryManifest.binaries.map((binary) => {
    const targets = Object.values(binary.targets);
    const review = downloadReviews.find(
      (entry) => entry.name === binary.name && entry.version === binary.version,
    );
    if (
      !review ||
      JSON.stringify(review.archives) !==
        JSON.stringify(targets.map((target) => target.sha256).sort())
    )
      throw new Error('Downloaded component needs a licence/provenance review: ' + binary.name);
    const files = targets
      .flatMap((target) => Object.values(target.extract?.files ?? {}))
      .map((file) => (binary.dir ?? 'resources/bin/' + binary.name) + '/' + file);
    for (const file of files) knownResources.add(file);
    if (
      files.length !== Object.keys(review.files).length ||
      files.some((file) => review.files[file] !== hash(file))
    )
      throw new Error('Downloaded component contents changed: ' + binary.name);
    const licenceFiles = files.filter((file) => /licen[sc]e/i.test(basename(file)));
    if (!licenceFiles.length || licenceFiles.some((file) => !existsSync(file)))
      throw new Error('Downloaded component is missing licence files: ' + binary.name);
    for (const file of licenceFiles)
      notices.push(binary.name + '\n\n' + readFileSync(file, 'utf8'));
    return {
      id: binary.name,
      version: binary.version,
      license: review.license,
      targets,
      files: files.map((file) => ({ file, sha256: hash(file) })),
    };
  });
  for (const input of inputs) {
    if (
      input.startsWith('resources/') &&
      /\.(ttf|otf|wasm|dll|exe|so|dylib)$/i.test(input) &&
      !knownResources.has(input)
    )
      throw new Error('Downloaded/binary build input is not inventoried: ' + input);
  }
  const reviews = (
    JSON.parse(readFileSync('resources/licenses/artifacts.json', 'utf8')) as {
      artifacts: ArtifactReview[];
    }
  ).artifacts;
  for (const input of inputs) {
    if (
      input.includes('node_modules/') &&
      /\.(wasm|dll|exe|so|dylib)$/i.test(input) &&
      !reviews.some((review) => review.file === input)
    )
      throw new Error('Opaque bundled input needs a provenance review: ' + input);
  }
  for (const review of reviews) {
    verifyArtifactReview(review);
    for (const notice of review.notices)
      notices.push(review.id + '\n\n' + readFileSync(notice, 'utf8'));
  }
  // Electron supplies its complete Chromium notice file in the installed runtime.
  const runtimeNotices = [
    'node_modules/electron/dist/LICENSE',
    'node_modules/electron/dist/LICENSES.chromium.html',
  ];
  for (const file of runtimeNotices)
    if (!existsSync(file)) throw new Error('Electron runtime notice is missing: ' + file);
  const runtime = JSON.parse(readFileSync('node_modules/electron/package.json', 'utf8')) as {
    version: string;
  };
  const problems = releaseProblems(components, reviews);
  mkdirSync('out/notices', { recursive: true });
  writeFileSync(
    'out/notices/third-party.json',
    JSON.stringify(
      {
        version: 1,
        components,
        downloaded,
        artifacts: reviews,
        electron: {
          version: runtime.version,
          notices: runtimeNotices.map((file) => ({
            file: relative(process.cwd(), resolve(file)).replaceAll('\\', '/'),
            sha256: hash(file),
          })),
        },
        inputs,
        releaseReady: problems.length === 0,
        releaseBlockers: problems,
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync('out/notices/NOTICES.txt', notices.join('\n\n' + '='.repeat(72) + '\n\n'));
  return problems;
}
