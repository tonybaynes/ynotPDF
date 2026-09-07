/**
 * The pre-commit hook must refuse secrets, certificates and PDFs outside test/fixtures/.
 * Each case creates a throw-away git repo, installs the hook and tries to commit.
 */

import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HOOK = resolve(process.cwd(), '.githooks', 'pre-commit');

let repo: string;

function git(args: string[], opts: ExecFileSyncOptions = {}): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      YNOT_SKIP_LINT_STAGED: '1',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
    ...opts,
  }) as string;
}

function stage(rel: string, content: string | Buffer): void {
  const full = join(repo, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  git(['add', '-f', rel]);
}

function tryCommit(): { ok: boolean; output: string } {
  try {
    const out = git(['commit', '-q', '-m', 'test']);
    return { ok: true, output: out };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message: string };
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message}` };
  }
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'ynot-hook-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'core.autocrlf', 'false']);
  mkdirSync(join(repo, '.githooks'), { recursive: true });
  const hook = join(repo, '.githooks', 'pre-commit');
  copyFileSync(HOOK, hook);
  chmodSync(hook, 0o755);
  git(['config', 'core.hooksPath', '.githooks']);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('pre-commit hook', () => {
  it('allows an ordinary source file', () => {
    stage('src/a.ts', 'export const a = 1;\n');
    expect(tryCommit().ok).toBe(true);
  });

  it('refuses a staged .p12 certificate', () => {
    stage('certs/signing.p12', Buffer.from([0x30, 0x82, 0x01, 0x00]));
    const r = tryCommit();
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/REFUSED certificate/);
  });

  it('refuses a staged .env file', () => {
    stage('.env', 'API_KEY=abc\n');
    const r = tryCommit();
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/REFUSED environment file/);
    git(['reset', '-q']);
    stage('config/.env.local', 'X=1\n');
    expect(tryCommit().output).toMatch(/REFUSED environment file/);
  });

  it('refuses a .pdf outside test/fixtures/ but allows one inside', () => {
    stage('docs/customer.pdf', '%PDF-1.4\n%%EOF\n');
    const r = tryCommit();
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/REFUSED PDF outside test\/fixtures/);
    git(['reset', '-q']);
    stage('test/fixtures/blank.pdf', '%PDF-1.4\n%%EOF\n');
    expect(tryCommit().ok).toBe(true);
  });

  it('refuses binaries and fetched resources', () => {
    stage('resources/bin/pdfium/pdfium.dll', Buffer.from([0x4d, 0x5a]));
    expect(tryCommit().output).toMatch(/REFUSED/);
    git(['reset', '-q']);
    stage('tools/helper.exe', Buffer.from([0x4d, 0x5a]));
    expect(tryCommit().output).toMatch(/REFUSED binary artefact/);
  });

  it('refuses staged content that looks like a private key or token', () => {
    // Assembled from parts so this test file itself does not trip the hook.
    const marker = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ');
    stage('src/key.ts', `const k = \`${marker}\nabc\n-----END RSA PRIVATE KEY-----\`;\n`);
    expect(tryCommit().output).toMatch(/looks like a secret/);
    git(['reset', '-q']);
    stage('src/token.ts', `const t = 'ghp_${'a'.repeat(36)}';\n`);
    expect(tryCommit().output).toMatch(/looks like a secret/);
  });
});
