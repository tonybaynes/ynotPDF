/**
 * M50 acceptance tests — page objects inside the real, built app.
 *
 * The unit tests own the arithmetic and the file: `test/unit/content/` proves the parser
 * round-trips and edits correctly, `test/unit/engine/objects*.test.ts` proves PDFium moves,
 * removes, reorders and copies objects with the render agreeing, and
 * `test/unit/writer/objects.test.ts` proves the save replays edits onto the original stream.
 * This file owns what only exists with a DOM, a viewer and a running PDFium: the tool, the
 * selection, a pointer drag, the panel, the clipboard between two documents, and a save that is
 * reopened.
 *
 * Each acceptance line in `docs/modules/M50-object-model.md` has a test named after it.
 */

import { expect, test } from '@playwright/test';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { engine as pdfium } from '../unit/engine/helpers';
import { launchApp, type App } from './harness';

const FIXTURES = join(process.cwd(), 'test', 'fixtures');

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface ObjectRow {
  index: number;
  kind: string;
  rect: Rect;
  id: string;
  strokeColor?: number;
  strokeWidth?: number;
}

interface UnitRow {
  id: string;
  kind: string;
  rect: Rect;
  indexes: number[];
}

interface ObjectsProbe {
  objects: ObjectRow[];
  units: UnitRow[];
  groups: Record<string, string[]>;
}

interface SelectionProbe {
  page: number | null;
  units: string[];
  objectIds: string[];
  bounds: Rect | null;
  description: string;
}

function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`expected a ${what}, got nothing`);
  return value;
}

let app: App;
let workspace: string;

test.beforeAll(async () => {
  app = await launchApp();
  workspace = mkdtempSync(join(tmpdir(), 'ynot-m50-'));
});

test.afterAll(async () => {
  await app.close();
  rmSync(workspace, { recursive: true, force: true });
});

function stage(name: string, as: string): string {
  const path = join(workspace, as);
  copyFileSync(join(FIXTURES, name), path);
  return path;
}

async function openPath(path: string): Promise<void> {
  const bytes = Array.from(readFileSync(path));
  await app.run('file.openBytes', { file: { path, name: path.split(/[\\/]/).pop(), bytes } });
  await app.page.waitForSelector('.viewer-content .page');
  await app.page.waitForTimeout(250);
}

/** Closes every tab, answering M21's "Save?" for each. */
async function closeAll(): Promise<void> {
  await app.run('object.deselect').catch(() => undefined);
  const closing = app.run('app.tabs.closeAll').catch(() => undefined);
  for (let i = 0; i < 8; i++) {
    const discard = app.page.locator('dialog[open] button', { hasText: "Don't save" });
    if ((await discard.count()) === 0) {
      await app.page.waitForTimeout(120);
      if ((await discard.count()) === 0) break;
    }
    await discard.first().click();
    await app.page.waitForTimeout(120);
  }
  await closing;
  await app.page.waitForTimeout(150);
}

const objects = (page = 0): Promise<ObjectsProbe> =>
  app.run('dev.objects', { page }) as Promise<ObjectsProbe>;
const selection = (): Promise<SelectionProbe> =>
  app.run('dev.objectSelection') as Promise<SelectionProbe>;

async function until<T>(probe: () => Promise<T>, ready: (value: T) => boolean, timeout = 10_000) {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (ready(value)) return value;
    if (Date.now() - start > timeout) throw new Error('condition not met in time');
    await app.page.waitForTimeout(120);
  }
}

async function selectUnit(page: number, id: string): Promise<void> {
  await app.run('object.select', { page, ids: [id] });
  await app.page.waitForTimeout(80);
}

test.describe('M50 — page objects', () => {
  test('registers its commands and tools', async () => {
    const commands = await app.commands();
    for (const id of [
      'object.edit',
      'object.edit.text',
      'object.edit.image',
      'object.edit.path',
      'object.edit.shading',
      'object.selectAll',
      'object.delete',
      'object.cut',
      'object.copy',
      'object.paste',
      'object.duplicate',
      'object.rotate.cw',
      'object.flip.horizontal',
      'object.align.left',
      'object.distribute.vertical',
      'object.arrange.front',
      'object.group',
      'object.ungroup',
      'object.snap.objects',
    ]) {
      expect(commands, id).toContain(id);
    }
  });

  test('move an image 10 pt; save; reopen ⇒ bbox moved 10 pt; render diff only in that region', async () => {
    const path = stage('image.pdf', 'move.pdf');
    const original = new Uint8Array(readFileSync(path));
    await openPath(path);
    await app.run('object.edit');
    const before = await objects(0);
    const image = must(
      before.units.find((u) => u.kind === 'image'),
      'image unit',
    );
    await selectUnit(0, image.id);
    const sel = await selection();
    expect(sel.units).toEqual([image.id]);
    expect(sel.description).toBe('Image');
    await expect(app.page.locator('.obj-props')).toBeVisible();

    await app.run('object.move', { dx: 10, dy: 0 });
    const after = await until(
      () => objects(0),
      (p) => {
        const u = p.units.find((x) => x.id === image.id);
        return u !== undefined && Math.abs(u.rect.x0 - image.rect.x0 - 10) < 0.01;
      },
    );
    const moved = must(
      after.units.find((x) => x.id === image.id),
      'moved unit',
    );
    expect(moved.rect.y0).toBeCloseTo(image.rect.y0, 2);

    const outcome = (await app.run('file.save')) as { saved: boolean };
    expect(outcome.saved).toBe(true);
    await closeAll();

    await openPath(path);
    await app.run('object.edit');
    const reopened = await objects(0);
    const again = must(
      reopened.objects.find(
        (o) => o.kind === 'image' && Math.abs(o.rect.y0 - image.rect.y0) < 0.01,
      ),
      'reopened image',
    );
    expect(again.rect.x0).toBeCloseTo(image.rect.x0 + 10, 1);
    await closeAll();

    // The saved file renders the same everywhere except where the image was and now is.
    const engine = await pdfium();
    const a = engine.openSync(original);
    const b = engine.openSync(new Uint8Array(readFileSync(path)));
    try {
      const height = (await engine.pageSize(a, 0)).height;
      const ra = await engine.renderRaw(a, 0, 1);
      const rb = await engine.renderRaw(b, 0, 1);
      const region = {
        x0: image.rect.x0 - 2,
        y0: image.rect.y0 - 2,
        x1: image.rect.x1 + 12,
        y1: image.rect.y1 + 2,
      };
      let outside = 0;
      let inside = 0;
      for (let y = 0; y < ra.height; y++) {
        const py = height - y;
        for (let x = 0; x < ra.width; x++) {
          const i = (y * ra.width + x) * 4;
          const differs =
            ra.rgba[i] !== rb.rgba[i] ||
            ra.rgba[i + 1] !== rb.rgba[i + 1] ||
            ra.rgba[i + 2] !== rb.rgba[i + 2];
          if (!differs) continue;
          if (x >= region.x0 && x <= region.x1 && py >= region.y0 && py <= region.y1) inside++;
          else outside++;
        }
      }
      expect(outside).toBe(0);
      expect(inside).toBeGreaterThan(100);
    } finally {
      await engine.close(a);
      await engine.close(b);
    }
  });

  test('z-order: send an object to the back, and undo brings it forward again', async () => {
    const path = stage('multipage.pdf', 'order.pdf');
    await openPath(path);
    await app.run('object.edit');
    const before = await objects(0);
    const kinds = before.objects.map((o) => o.kind);
    expect(kinds).toContain('path');
    expect(kinds).toContain('text');
    const path0 = must(
      before.units.find((u) => u.kind === 'path'),
      'path unit',
    );
    const pathIndex = must(path0.indexes[0], 'index');
    expect(pathIndex).toBeGreaterThan(0);

    await selectUnit(0, path0.id);
    await app.run('object.arrange.back');
    const after = await until(
      () => objects(0),
      (p) => p.objects[0]?.kind === 'path',
    );
    expect(after.objects[0]?.kind).toBe('path');
    // The selection follows the object to its new index.
    expect((await selection()).objectIds.length).toBe(1);

    await app.run('edit.undo');
    const restored = await until(
      () => objects(0),
      (p) => p.objects[pathIndex]?.kind === 'path',
    );
    expect(restored.objects.map((o) => o.kind)).toEqual(kinds);
    await closeAll();
  });

  test('copy a path object to another document ⇒ it is there, in place, and survives a save', async () => {
    const source = stage('multipage.pdf', 'source.pdf');
    const target = stage('blank.pdf', 'target.pdf');
    await openPath(source);
    await app.run('object.edit');
    const before = await objects(0);
    const path0 = must(
      before.units.find((u) => u.kind === 'path'),
      'path unit',
    );
    await selectUnit(0, path0.id);
    expect(await app.run('object.copy')).toBe(true);

    await openPath(target);
    await app.run('object.edit');
    expect((await objects(0)).units.length).toBe(0);
    expect(await app.run('object.paste')).toBe(1);
    const pasted = await until(
      () => objects(0),
      (p) => p.units.length === 1,
    );
    const unit = must(pasted.units[0], 'pasted unit');
    expect(unit.kind).toBe('form');
    expect(unit.rect.x0).toBeCloseTo(path0.rect.x0, 0);
    expect(unit.rect.y1).toBeCloseTo(path0.rect.y1, 0);
    expect((await selection()).units).toEqual([unit.id]);

    expect(((await app.run('file.save')) as { saved: boolean }).saved).toBe(true);
    await closeAll();
    await openPath(target);
    await app.run('object.edit');
    const saved = await objects(0);
    expect(saved.objects.map((o) => o.kind)).toEqual(['form']);
    expect(saved.objects[0]?.rect.x0).toBeCloseTo(path0.rect.x0, 0);
    await closeAll();
  });

  test('align/distribute objects ⇒ positions match computed expectations', async () => {
    const path = stage('image.pdf', 'align.pdf');
    await openPath(path);
    await app.run('object.edit');
    await app.run('object.selectAll', { page: 0 });
    const sel = await selection();
    expect(sel.units.length).toBeGreaterThanOrEqual(3);
    const before = await objects(0);
    const left = Math.min(...before.units.map((u) => u.rect.x0));

    await app.run('object.align.left');
    const aligned = await until(
      () => objects(0),
      (p) => p.units.every((u) => Math.abs(u.rect.x0 - left) < 0.05),
    );
    for (const u of aligned.units) expect(u.rect.x0).toBeCloseTo(left, 1);
    // Widths never change under an align.
    for (const u of aligned.units) {
      const was = must(
        before.units.find((b) => b.id === u.id),
        'unit',
      );
      expect(u.rect.x1 - u.rect.x0).toBeCloseTo(was.rect.x1 - was.rect.x0, 1);
    }

    await app.run('object.selectAll', { page: 0 });
    const centres = aligned.units.map((u) => (u.rect.y0 + u.rect.y1) / 2).sort((a, b) => a - b);
    await app.run('object.distribute.vertical');
    const distributed = await until(
      () => objects(0),
      (p) => {
        const c = p.units.map((u) => (u.rect.y0 + u.rect.y1) / 2).sort((a, b) => a - b);
        const step = ((c[c.length - 1] ?? 0) - (c[0] ?? 0)) / Math.max(1, c.length - 1);
        return c.every((v, i) => Math.abs(v - ((c[0] ?? 0) + step * i)) < 0.05);
      },
    );
    const c = distributed.units.map((u) => (u.rect.y0 + u.rect.y1) / 2).sort((a, b) => a - b);
    expect(c[0]).toBeCloseTo(centres[0] ?? 0, 1);
    expect(c[c.length - 1]).toBeCloseTo(centres[centres.length - 1] ?? 0, 1);

    await app.run('edit.undo');
    await app.run('edit.undo');
    const undone = await until(
      () => objects(0),
      (p) =>
        p.units.every((u) => {
          const was = before.units.find((b) => b.id === u.id);
          return was !== undefined && Math.abs(u.rect.x0 - was.rect.x0) < 0.05;
        }),
    );
    expect(undone.units.length).toBe(before.units.length);
    await closeAll();
  });

  test('drags an image with the pointer, resizes it from a handle, and deletes it with Delete', async () => {
    const path = stage('image.pdf', 'drag.pdf');
    await openPath(path);
    await app.run('object.edit');
    await app.run('view.zoom.actual');
    await app.page.waitForTimeout(200);
    const before = await objects(0);
    const image = must(
      before.units.find((u) => u.kind === 'image'),
      'image unit',
    );
    const page = app.page.locator('.viewer-content .page').first();
    const box = must(await page.boundingBox(), 'page box');
    const scale = box.width / 595.28;
    const device = (x: number, y: number): [number, number] => [
      box.x + x * scale,
      box.y + (841.89 - y) * scale,
    ];
    const centre = device((image.rect.x0 + image.rect.x1) / 2, (image.rect.y0 + image.rect.y1) / 2);

    // Alt suppresses snapping so the distance is exactly what the pointer did.
    await app.page.keyboard.down('Alt');
    await app.page.mouse.move(centre[0], centre[1]);
    await app.page.mouse.down();
    await app.page.mouse.move(centre[0] + 10, centre[1], { steps: 4 });
    await app.page.mouse.move(centre[0] + 30 * scale, centre[1], { steps: 6 });
    await app.page.mouse.up();
    await app.page.keyboard.up('Alt');
    const moved = await until(
      () => objects(0),
      (p) => {
        const u = p.units.find((x) => x.id === image.id);
        return u !== undefined && Math.abs(u.rect.x0 - image.rect.x0 - 30) < 0.5;
      },
    );
    const at = must(
      moved.units.find((x) => x.id === image.id),
      'moved',
    );
    expect((await selection()).units).toEqual([image.id]);

    // Drag the east handle 20 px further right: wider, same left edge.
    const east = device(at.rect.x1, (at.rect.y0 + at.rect.y1) / 2);
    await app.page.mouse.move(east[0], east[1]);
    await app.page.mouse.down();
    await app.page.mouse.move(east[0] + 20 * scale, east[1], { steps: 6 });
    await app.page.mouse.up();
    const resized = await until(
      () => objects(0),
      (p) => {
        const u = p.units.find((x) => x.id === image.id);
        return u !== undefined && Math.abs(u.rect.x1 - at.rect.x1 - 20) < 0.5;
      },
    );
    const wider = must(
      resized.units.find((x) => x.id === image.id),
      'resized',
    );
    expect(wider.rect.x0).toBeCloseTo(at.rect.x0, 1);

    await app.page.keyboard.press('Delete');
    const gone = await until(
      () => objects(0),
      (p) => p.units.length === before.units.length - 1,
    );
    expect(gone.units.find((u) => u.id === image.id)).toBeUndefined();
    await app.run('edit.undo');
    await until(
      () => objects(0),
      (p) => p.units.length === before.units.length,
    );
    await closeAll();
  });

  test('groups objects so one click selects them all, and a style change reaches a shape', async () => {
    const path = stage('multipage.pdf', 'group.pdf');
    await openPath(path);
    await app.run('object.edit');
    await app.run('object.selectAll', { page: 0 });
    const all = await selection();
    expect(all.units.length).toBeGreaterThanOrEqual(2);
    await app.run('object.group');
    const grouped = await until(
      () => objects(0),
      (p) => Object.keys(p.groups).length === 1,
    );
    expect(Object.values(grouped.groups)[0]?.length).toBe(all.objectIds.length);
    await app.run('object.deselect');
    const one = must(grouped.units[0], 'unit');
    await selectUnit(0, one.id);
    expect((await selection()).units.length).toBe(all.units.length);
    await app.run('object.ungroup');
    await until(
      () => objects(0),
      (p) => Object.keys(p.groups).length === 0,
    );

    const shape = must(
      grouped.units.find((u) => u.kind === 'path'),
      'path unit',
    );
    await selectUnit(0, shape.id);
    expect((await selection()).description).toBe('Shape');
    await app.run('object.style', { strokeColor: 0x0000ff, strokeWidth: 4 });
    const styled = await until(
      () => objects(0),
      (p) => p.objects[must(shape.indexes[0], 'index')]?.strokeColor === 0x0000ff,
    );
    expect(styled.objects[must(shape.indexes[0], 'index')]?.strokeWidth).toBeCloseTo(4, 2);
    await closeAll();
  });
});
