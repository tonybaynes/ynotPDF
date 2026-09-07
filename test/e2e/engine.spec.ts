/**
 * M10 e2e: the PDFium WASM engine runs inside the real (built) app's worker. Drives the
 * `dev.engineOpen` probe command through the harness with fixture bytes and checks the result
 * against the corpus snapshot, so the in-app render matches the Node-tested render.
 */

import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hamming } from '../../src/engine/imageHash';
import type { EngineProbe } from '../../src/renderer/modules/M10-engine-layer/manifest';
import { launchApp, type App } from './harness';

const fixtures = join(process.cwd(), 'test', 'fixtures');
const snapshots = JSON.parse(
  readFileSync(join(fixtures, 'hashes', `${process.platform}.json`), 'utf8'),
) as Record<string, { render: string[]; text: string }>;

let app: App;
test.beforeAll(async () => {
  app = await launchApp();
});
test.afterAll(async () => {
  await app.close();
});

test('the probe command is registered for the palette', async () => {
  const commands = await app.commands();
  expect(commands).toContain('dev.engineOpen');
  expect(commands).toContain('dev.engineInfo');
});

test('the worker reports the PDFium engine', async () => {
  const info = (await app.run('dev.engineInfo')) as { name: string; version: string };
  expect(info.name).toBe('pdfium');
  expect(info.version).toContain('wasm');
});

test('opens, extracts and renders a fixture inside the app', async () => {
  const bytes = Array.from(readFileSync(join(fixtures, 'text.pdf')));
  const probe = (await app.run('dev.engineOpen', { bytes, name: 'text.pdf' })) as EngineProbe;
  expect(probe.pages).toBe(1);
  expect(probe.width).toBeCloseTo(595.28, 1);
  expect(probe.text).toContain('Heading in Helvetica 24 pt');
  expect(probe.bitmapWidth).toBe(595);
  expect(probe.bitmapHeight).toBe(842);
  const stored = snapshots['text.pdf']?.render[0];
  expect(stored).toBeDefined();
  expect(hamming(probe.hash, stored ?? '')).toBeLessThanOrEqual(6);
  expect(probe.renderMs).toBeLessThan(2000);
});

test('structure comes through the RPC: annotations, fields, layers, attachments, links', async () => {
  const run = (name: string, password?: string) =>
    app.run('dev.engineOpen', {
      bytes: Array.from(readFileSync(join(fixtures, name))),
      name,
      ...(password === undefined ? {} : { password }),
    }) as Promise<EngineProbe>;
  expect((await run('annotated.pdf')).annotations).toBe(5);
  expect((await run('form.pdf')).fields).toBe(6);
  expect((await run('layers.pdf')).layers).toBe(2);
  expect((await run('attachments.pdf')).attachments).toBe(2);
  expect((await run('links.pdf')).links).toBe(3);
  expect((await run('outline.pdf')).outline).toBe(3);
  const enc = await run('encrypted-aes256.pdf', 'ynot');
  expect(enc.encrypted).toBe(true);
  expect(enc.text).toContain('AES-256');
  expect((await run('xfa.pdf')).hasXfa).toBe(true);
});

test('errors cross the worker boundary with their codes', async () => {
  const bytes = Array.from(readFileSync(join(fixtures, 'encrypted.pdf')));
  await expect(app.run('dev.engineOpen', { bytes, name: 'encrypted.pdf' })).rejects.toThrow(
    /password/i,
  );
  await expect(
    app.run('dev.engineOpen', { bytes, name: 'encrypted.pdf', password: 'wrong' }),
  ).rejects.toThrow(/wrong password/i);
  const garbage = Array.from(readFileSync(join(fixtures, 'corrupt.pdf')));
  await expect(app.run('dev.engineOpen', { bytes: garbage, name: 'corrupt.pdf' })).rejects.toThrow(
    /readable PDF/i,
  );
});
