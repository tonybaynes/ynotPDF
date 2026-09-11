/**
 * M53 journeys — headers and footers, Bates numbering, watermarks, and links (ADR 0020).
 *
 * Every one of these presses the button a person presses: the ribbon by its visible label, the
 * dialog's own fields, the dialog's own footer buttons, and the page itself. `app.run` appears
 * only to open a file and to read the module's state back through `dev.*`, which is what the
 * coverage spec allows it for.
 */

import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, type App } from '../harness';
import { closeEverything, journey } from '../journey';
import { expectNothingClipped, expectWindowSound } from '../layout';

const FIXTURES = join(process.cwd(), 'test', 'fixtures');

let app: App;

test.beforeAll(async () => {
  app = await launchApp({ noDemo: true });
});

test.afterAll(async () => {
  await app.close();
});

test.afterEach(async () => {
  await closeEverything(app);
});

interface DecorationProbe {
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly pages: number;
    readonly range: string;
  }>;
  readonly capturedPages: number;
}

interface LinkProbe {
  readonly id: string;
  readonly page: number;
  readonly action: string;
  readonly uri: string;
  readonly target: number;
}

async function decorationsOf(app: App): Promise<DecorationProbe> {
  return (await app.run('dev.decorations')) as DecorationProbe;
}

/**
 * Waits until the module holds `count` decorations.
 *
 * The dialog closes the moment its button is pressed; putting the marks on the pages happens
 * after that, and on a hundred pages it takes a moment. Polling is what a reader does too — they
 * watch the pages change.
 */
async function expectDecorationCount(app: App, count: number, message: string): Promise<void> {
  await expect.poll(async () => (await decorationsOf(app)).items.length, { message }).toBe(count);
}

async function linksOf(app: App): Promise<ReadonlyArray<LinkProbe>> {
  return (await app.run('dev.links')) as ReadonlyArray<LinkProbe>;
}

/** Types into a dialog field by the text of its own label. */
async function fill(app: App, dialog: string, label: string, value: string): Promise<void> {
  const field = app.page
    .locator(`${dialog} .field`)
    .filter({ has: app.page.locator('label', { hasText: label }) })
    .first();
  await expect(field, `no "${label}" field in ${dialog}`).toHaveCount(1);
  const input = field.locator('input, select, textarea').first();
  await input.fill(value);
  await input.dispatchEvent('input');
}

test('M53: a header goes on every page and comes off again', async () => {
  const j = journey(app);
  await j.openDocument(join(FIXTURES, 'multipage.pdf'));

  await j.clickRibbon('edit', 'Header and Footer…');
  const dialog = app.page.locator('#header-footer-dialog');
  await expect(dialog, 'the header and footer dialog did not open').toBeVisible();
  // The preview is the real page, rendered by the engine.
  await expect(dialog.locator('[data-testid="decoration-preview"] canvas')).toBeVisible();
  await expectNothingClipped(dialog);

  await fill(app, '#header-footer-dialog', 'Header, left', 'ACME LIMITED');
  await fill(app, '#header-footer-dialog', 'Footer, centre', '<<1 of n>>');
  await j.clickDialogButton('#header-footer-dialog', 'Add');
  await expect(dialog).toBeHidden();

  await expectDecorationCount(app, 1, 'the header never reached the pages');
  const after = await decorationsOf(app);
  expect(after.items[0]?.kind).toBe('header-footer');
  expect(after.items[0]?.pages).toBe(5);
  // Every decorated page had its own content captured, so a save can put it back.
  expect(after.capturedPages).toBe(5);

  // Off again, through the ribbon's Remove menu — two clicks, which is what the reader makes.
  await j.clickRibbon('edit', 'More Marks');
  await j.clickMenuItem('Remove Header and Footer');
  await expect
    .poll(async () => (await decorationsOf(app)).items.length, {
      message: 'the header was still there after Remove',
    })
    .toBe(0);

  await expectWindowSound(app.page);
});

test('M53: Bates numbering runs from the number the reader chose', async () => {
  const j = journey(app);
  await j.openDocument(join(FIXTURES, 'multipage.pdf'));

  await j.clickRibbon('edit', 'Bates Numbering…');
  const dialog = app.page.locator('#bates-dialog');
  await expect(dialog).toBeVisible();

  await dialog.locator('[data-testid="bates-prefix"]').fill('ACME');
  await dialog.locator('[data-testid="bates-prefix"]').dispatchEvent('input');
  await dialog.locator('[data-testid="bates-digits"]').fill('6');
  await dialog.locator('[data-testid="bates-digits"]').dispatchEvent('input');
  await dialog.locator('[data-testid="bates-start"]').fill('123');
  await dialog.locator('[data-testid="bates-start"]').dispatchEvent('input');
  // The dialog says what the first page will read, before anything is applied.
  await expect(dialog.locator('.decoration-sample')).toContainText('ACME000123');
  await expectNothingClipped(dialog);

  await j.clickDialogButton('#bates-dialog', 'Add');
  await expect(dialog).toBeHidden();

  await expectDecorationCount(app, 1, 'the numbering never reached the pages');
  const after = await decorationsOf(app);
  expect(after.items.map((d) => d.kind)).toEqual(['bates']);
  expect(after.items[0]?.pages).toBe(5);

  await expectWindowSound(app.page);
});

test('M53: a watermark goes behind the page contents', async () => {
  const j = journey(app);
  await j.openDocument(join(FIXTURES, 'text.pdf'));

  await j.clickRibbon('edit', 'Watermark…');
  const dialog = app.page.locator('#watermark-dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('[data-testid="watermark-text"]').fill('DRAFT');
  await dialog.locator('[data-testid="watermark-text"]').dispatchEvent('input');
  await expectNothingClipped(dialog);
  await j.clickDialogButton('#watermark-dialog', 'Add');
  await expect(dialog).toBeHidden();

  await expectDecorationCount(app, 1, 'the watermark never reached the pages');
  const after = await decorationsOf(app);
  expect(after.items.map((d) => d.kind)).toEqual(['watermark']);

  await expectWindowSound(app.page);
});

test('M53: the addresses in the text become links, and one asks before it opens', async () => {
  const j = journey(app);
  await j.openDocument(join(FIXTURES, 'urls.pdf'));

  await j.clickRibbon('edit', 'Create Links from Text…');
  const review = app.page.locator('#detected-links-dialog');
  await expect(review, 'the review dialog did not open').toBeVisible();
  // Every candidate is listed for review; nothing is written until Create is pressed.
  const rows = review.locator('[data-testid="link-candidates"] .link-candidate');
  await expect(rows).toHaveCount(13);
  await expectNothingClipped(review);

  await j.clickDialogButton('#detected-links-dialog', 'Create links');
  await expect(review).toBeHidden();

  await expect
    .poll(async () => (await linksOf(app)).length, { message: 'the links were never created' })
    .toBe(14);
  const links = await linksOf(app);
  // Thirteen new ones plus the one the fixture already had on page 1.
  expect(links.filter((l) => l.action === 'uri')).toHaveLength(14);
  expect(links.map((l) => l.uri)).toContain('https://example.com');
  expect(links.map((l) => l.uri)).toContain('mailto:sales@example.com');
  // The trap: a version number and a footnote marker are not addresses.
  expect(links.some((l) => l.uri.includes('1.2.3'))).toBe(false);

  // Clicking one on the page asks first, and says exactly where it goes.
  const target = links.find((l) => l.uri === 'https://example.com' && l.page === 0);
  expect(target, 'no link to click').toBeDefined();
  if (!target) return;
  const area = app.page.locator(`.page[data-page="0"] .layer-link [data-link-id="${target.id}"]`);
  await expect(area, 'the link area is not on the page').toHaveCount(1);
  // The layer repaints on every animation frame, so the rectangle is a fresh element each time:
  // `click` re-resolves the locator, where a held reference would go stale.
  await area.click();
  const confirm = app.page.locator('#link-confirm-dialog');
  await expect(confirm, 'clicking a link did not ask first').toBeVisible();
  await expect(confirm.locator('[data-testid="link-confirm-address"]')).toHaveText(
    'https://example.com',
  );
  await j.clickDialogButton('#link-confirm-dialog', 'Cancel');
  await expect(confirm).toBeHidden();

  await expectWindowSound(app.page);
});

test('M53: a link drawn on the page goes where the reader said', async () => {
  const j = journey(app);
  await j.openDocument(join(FIXTURES, 'multipage.pdf'));

  await j.clickRibbon('edit', 'Link');
  // The tool says it is active by the cursor it asks for; without this the drag below would fail
  // with "no dialog" rather than with "the tool never came on".
  await expect(app.page.locator('.viewer[data-tool-cursor="crosshair"]')).toHaveCount(1);
  await j.dragOnPageAt([0.2, 0.2], [0.6, 0.3]);

  const dialog = app.page.locator('#link-dialog');
  await expect(dialog, 'drawing a rectangle did not ask what the link does').toBeVisible();
  await dialog.locator('[data-testid="link-uri"]').fill('https://example.org/new');
  await expectNothingClipped(dialog);
  await j.clickDialogButton('#link-dialog', 'OK');
  await expect(dialog).toBeHidden();

  await expect
    .poll(async () => (await linksOf(app)).length, { message: 'the link was never created' })
    .toBe(1);
  const links = await linksOf(app);
  expect(links[0]?.uri).toBe('https://example.org/new');

  // And the panel lists it, in words.
  await j.openPanel('nav.links');
  await expect(app.page.locator('[data-testid="links-panel"] .links-what').first()).toContainText(
    'https://example.org/new',
  );

  await expectWindowSound(app.page);
});
