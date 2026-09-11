/**
 * M91 e2e: creating PDFs in the real, built app.
 *
 * The web half of the module's acceptance tests lives here and can live nowhere else: printing a
 * page to PDF is Chromium's, in a hidden window in the main process, and only the running app
 * has one. The local HTML fixture site is loaded over `file:` so the test needs no network.
 *
 * The image and text acceptance tests are unit tests (`test/unit/create/`), where they run
 * against the real engine in a second; what is asserted here is the rest of the claim — that a
 * created document arrives in a tab, unsaved, with the reader's title on it, and that the
 * dialogs open, are opaque, and are reachable from the ribbon and the palette.
 */

import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchApp, type App } from './harness';

const fixtures = join(process.cwd(), 'test', 'fixtures', 'create');
const site = (name: string): string => pathToFileURL(join(fixtures, 'site', name)).href;

interface Outcome {
  readonly kind: string;
  readonly title: string;
  readonly pageCount: number;
  readonly warnings: string[];
  readonly tabId: string | null;
}

interface CreateState {
  readonly busy: boolean;
  readonly untitled: number;
  readonly last: Outcome | null;
  readonly offThread: boolean;
}

interface PageSize {
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
}

interface Link {
  readonly uri: string | null;
  readonly page: number | null;
}

interface OutlineItem {
  readonly title: string;
  readonly page: number | null;
}

interface SaveState {
  readonly title: string;
  readonly path: string | null;
  readonly dirty: boolean;
}

const create = (
  app: App,
  kind: string,
  options: Record<string, unknown>,
  paths: string[] = [],
): Promise<Outcome> => app.run('create.convert', { kind, options, paths }) as Promise<Outcome>;

const sizes = (app: App): Promise<PageSize[]> => app.run('dev.pageSizes') as Promise<PageSize[]>;
const links = (app: App, page: number): Promise<Link[]> =>
  app.run('dev.pageLinks', { page }) as Promise<Link[]>;
const outline = (app: App): Promise<OutlineItem[]> =>
  app.run('dev.outline') as Promise<OutlineItem[]>;
const text = (app: App, page: number): Promise<string> =>
  app.run('dev.pageText', { page }) as Promise<string>;

let app: App;

test.beforeAll(async () => {
  app = await launchApp();
});

test.afterAll(async () => {
  await app.close();
});

test.describe('the module is wired into the shell', () => {
  test('every creation command is registered and in the palette', async () => {
    const commands = await app.commands();
    for (const id of [
      'create.blank',
      'create.fromImages',
      'create.fromFiles',
      'create.fromWebPage',
      'create.fromHtml',
      'create.fromText',
      'create.fromClipboard',
      'create.convert',
      'create.fromDropped',
    ]) {
      expect(commands).toContain(id);
    }
    await app.run('app.commandPalette');
    const palette = app.page.locator('#command-palette');
    await expect(palette).toBeVisible();
    await palette.locator('input').fill('create web');
    await expect(palette.locator('li[data-command="create.fromWebPage"]')).toBeVisible();
    await app.page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
  });

  test('the File → New page offers the creators instead of the placeholder', async () => {
    await app.run('app.backstage.open', { page: 'new' });
    const backstage = app.page.locator('#backstage');
    await expect(backstage).toBeVisible();
    await expect(backstage.locator('.creator-empty')).toHaveCount(0);
    for (const id of [
      'create.blank',
      'create.images',
      'create.web',
      'create.clipboard',
      'create.files',
    ]) {
      await expect(backstage.locator(`[data-creator="${id}"]`).first()).toBeVisible();
    }
    await app.run('app.backstage.close');
    await expect(backstage).toBeHidden();
  });
});

test.describe('the dialogs', () => {
  test('the blank dialog is opaque, keyboard-reachable, and creates what it previews', async () => {
    const opened = app.run('create.blank');
    const dialog = app.page.locator('#create-blank-dialog');
    await expect(dialog).toBeVisible();

    // Opaque, as every modal in this app must be (M01's rule, tested here on M91's dialog).
    const styles = await dialog.evaluate((node) => {
      const s = getComputedStyle(node);
      return { opacity: s.opacity, background: s.backgroundColor, filter: s.backdropFilter };
    });
    expect(styles.opacity).toBe('1');
    expect(styles.background).not.toMatch(/rgba\([^)]*,\s*0(\.\d+)?\)/);
    expect(['none', '']).toContain(styles.filter);

    // Every control is reachable from the keyboard, and the summary follows the choices.
    const size = dialog.locator('select').first();
    await size.selectOption('Letter');
    const orientation = dialog.locator('select').nth(1);
    await orientation.selectOption('landscape');
    const count = dialog.locator('input[type="number"]').first();
    await count.fill('3');
    await count.dispatchEvent('change');
    await expect(dialog.locator('.create-summary')).toContainText('3 pages');
    await expect(dialog.locator('.create-summary')).toContainText('landscape');

    await dialog.getByRole('button', { name: 'Create' }).click();
    const outcome = (await opened) as Outcome | null;
    expect(outcome).not.toBeNull();
    expect(outcome?.pageCount).toBe(3);
    expect(outcome?.title).toMatch(/^Untitled \d+$/);

    const measured = await sizes(app);
    expect(measured).toHaveLength(3);
    expect(measured[0]?.width).toBeCloseTo(792, 0);
    expect(measured[0]?.height).toBeCloseTo(612, 0);
  });

  test('Cancel creates nothing', async () => {
    const before = (await app.run('dev.createState')) as CreateState;
    const opened = app.run('create.blank');
    const dialog = app.page.locator('#create-blank-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(await opened).toBeNull();
    const after = (await app.run('dev.createState')) as CreateState;
    expect(after.last).toEqual(before.last);
  });

  test('the web dialog refuses an address it cannot load, in words', async () => {
    const opened = app.run('create.fromWebPage');
    const dialog = app.page.locator('#create-web-dialog');
    await expect(dialog).toBeVisible();
    const address = dialog.locator('input[type="text"]').first();
    await address.fill('mailto:someone@example.com');
    const error = dialog.locator('.field-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText('http://');
    await expect(dialog.getByRole('button', { name: 'Create' })).toBeDisabled();
    await address.fill('https://example.com');
    await expect(error).toBeHidden();
    await expect(dialog.getByRole('button', { name: 'Create' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await opened;
  });
});

test.describe('a created document is a document', () => {
  test('it opens in a tab, unsaved, titled after its source', async () => {
    const outcome = await create(app, 'blank', { count: 1, title: 'Notes for Monday' });
    expect(outcome.pageCount).toBe(1);
    const state = (await app.run('dev.saveState')) as SaveState | null;
    expect(state?.path).toBeNull();
    expect(state?.dirty).toBe(true);
    const summary = (await app.run('dev.documentSummary')) as {
      metadataTitle: string | null;
      dirty: boolean;
    };
    expect(summary.dirty).toBe(true);
    // The title is in the file as well as in the tab, so it survives a save.
    expect(summary.metadataTitle).toBe('Notes for Monday');
  });
});

test.describe('web pages', () => {
  test('a local site, two deep, becomes a PDF with bookmarks and working internal links', async () => {
    test.slow();
    const outcome = await create(app, 'web', {
      url: site('index.html'),
      depth: 2,
      sameSiteOnly: true,
      bookmarks: true,
      settings: { timeoutMs: 20_000 },
    });
    // index links to about and contact (and to a page outside the site, which is not followed).
    expect(outcome.pageCount).toBeGreaterThanOrEqual(3);

    const items = await outline(app);
    expect(items.length).toBe(3);
    expect(items.map((i) => i.title)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Home'),
        expect.stringContaining('About'),
        expect.stringContaining('Contact'),
      ]),
    );
    // Every bookmark points at a real page, and they are in crawl order.
    const pages = items.map((i) => i.page ?? -1);
    expect(pages[0]).toBe(0);
    expect(pages.every((p) => p >= 0)).toBe(true);
    expect([...pages].sort((a, b) => a - b)).toEqual(pages);

    const first = await links(app, 0);
    // The links to about.html and contact.html now go to pages inside this document…
    const internal = first.filter((l) => l.page !== null);
    expect(internal.length).toBeGreaterThanOrEqual(2);
    for (const link of internal) expect(link.page).toBeGreaterThan(0);
    // …and the link to another site is still a URL.
    expect(first.some((l) => l.uri?.includes('example.com'))).toBe(true);

    // The deep page is three hops away, so depth 2 must not have reached it.
    const all = await Promise.all([...items.keys()].map((i) => text(app, items[i]?.page ?? 0)));
    expect(all.join(' ')).not.toContain('Fixture site — Deep');
  });

  test('depth 1 is the page and nothing else', async () => {
    const outcome = await create(app, 'web', {
      url: site('about.html'),
      depth: 1,
      bookmarks: true,
      settings: { timeoutMs: 20_000 },
    });
    expect(outcome.pageCount).toBeGreaterThanOrEqual(1);
    const items = await outline(app);
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toContain('About');
    const body = await text(app, 0);
    expect(body).toContain('About');
  });

  test('an address that does not exist is reported, not swallowed', async () => {
    const failed = app.run('create.convert', {
      kind: 'web',
      options: {
        url: 'file:///nowhere/at/all/missing.html',
        depth: 1,
        settings: { timeoutMs: 5000 },
      },
    });
    await expect(failed).rejects.toThrow(/could not be loaded|not be created|ERR_FILE_NOT_FOUND/i);
  });
});

test.describe('Markdown and HTML files', () => {
  test('Markdown renders its headings and its table', async () => {
    test.slow();
    const outcome = await create(app, 'html', { settings: { timeoutMs: 20_000 } }, [
      join(fixtures, 'notes.md'),
    ]);
    expect(outcome.pageCount).toBeGreaterThanOrEqual(1);
    expect(outcome.title).toBe('notes');
    const body = await text(app, 0);
    // The headings, the table and the code block all survive the round trip.
    expect(body).toContain('Heading 1');
    expect(body).toContain('Heading 2');
    expect(body).toContain('Heading 3');
    expect(body).toMatch(/Name[\s\S]*Quantity[\s\S]*Price/);
    expect(body).toMatch(/Apple[\s\S]*Pear[\s\S]*Plum/);
    expect(body).toContain('First ordered item');
  });

  test('an HTML file keeps the title the page gave itself', async () => {
    const outcome = await create(app, 'html', { settings: { timeoutMs: 20_000 } }, [
      join(fixtures, 'site', 'about.html'),
    ]);
    expect(outcome.title).toContain('About');
  });
});

test.describe('plain text', () => {
  test('a long file is paginated with a header on every page', async () => {
    const outcome = await create(app, 'text', { header: true, fontSize: 10 }, [
      join(fixtures, 'long.txt'),
    ]);
    expect(outcome.pageCount).toBeGreaterThan(1);
    const second = await text(app, 1);
    expect(second).toContain('long.txt');
    expect(second).toMatch(/Page 2 of \d+/);
  });

  test('characters the standard fonts cannot show are named as a warning', async () => {
    const outcome = await create(app, 'text', {}, [join(fixtures, 'unicode.txt')]);
    expect(outcome.warnings.join(' ')).toMatch(/cannot show/);
    const body = await text(app, 0);
    expect(body).toContain('?');
  });
});

test.describe('images', () => {
  test('five mixed images become five pages, and the EXIF one lands the right way up', async () => {
    const outcome = await create(app, 'image', { pageMode: 'fixed', orientation: 'auto' }, [
      join(fixtures, 'photo-landscape.jpg'),
      join(fixtures, 'photo-exif-rotated.jpg'),
      join(fixtures, 'chart-300dpi.png'),
      join(fixtures, 'logo-alpha.png'),
      join(fixtures, 'scan-gray.png'),
    ]);
    expect(outcome.pageCount).toBe(5);
    const measured = await sizes(app);
    // The rotated photo is stored portrait and displays landscape: its page is landscape, and
    // the page itself is never rotated — the drawing is.
    expect(measured[1]?.width).toBeGreaterThan(measured[1]?.height ?? 0);
    for (const size of measured) expect(size.rotation).toBe(0);
  });

  test('a multi-page TIFF becomes one page per image', async () => {
    const outcome = await create(
      app,
      'image',
      { pageMode: 'image', margins: { top: 0, right: 0, bottom: 0, left: 0 } },
      [join(fixtures, 'pages-3.tif')],
    );
    expect(outcome.pageCount).toBe(3);
    const measured = await sizes(app);
    expect(measured[0]?.width).toBeCloseTo(90, 0);
    expect(measured[1]?.width).toBeCloseTo(60, 0);
  });

  test('a BMP is decoded by the platform rather than refused', async () => {
    const outcome = await create(app, 'image', {}, [join(fixtures, 'tiny.bmp')]);
    expect(outcome.pageCount).toBe(1);
  });

  test('a file that is not an image is reported in words', async () => {
    await expect(create(app, 'image', {}, [join(fixtures, 'not-an-image.png')])).rejects.toThrow(
      /not an image|could not be decoded|not be created/i,
    );
  });

  test('the conversion runs off the main thread', async () => {
    const state = (await app.run('dev.createState')) as CreateState;
    expect(state.offThread).toBe(true);
  });
});

test.describe('files that are not PDFs, dropped on the window', () => {
  test('images become one document and an unknown file is named to the reader', async () => {
    const png = [...readFileSync(join(fixtures, 'logo-alpha.png'))];
    const dropped = app.run('create.fromDropped', {
      files: [
        { name: 'logo-alpha.png', path: join(fixtures, 'logo-alpha.png'), bytes: png },
        { name: 'strange.xyz', path: 'strange.xyz', bytes: [1, 2, 3] },
      ],
    });
    // The file nothing accepts is said in words, straight away…
    await expect(app.page.locator('.toast', { hasText: 'strange.xyz' })).toBeVisible();
    // …and the image goes on to the image dialog, as a drop of one image should.
    const dialog = app.page.locator('#create-images-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('logo-alpha.png');
    await dialog.getByRole('button', { name: 'Create' }).click();
    const outcomes = (await dropped) as Outcome[];
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.pageCount).toBe(1);
  });
});

test.describe('a PDF dropped on the window', () => {
  /**
   * A dropped file has no path, and must not be given a fake one.
   *
   * `shell.ts` used to fall back to `f.name`, because `File.path` was an Electron extension that
   * was removed in Electron 32 and this app is on 44. Every dropped document therefore arrived
   * carrying its own *filename* as its path — and `SaveService.save()` sends a document to Save As
   * only when it has no path. `'multipage.pdf'` is not nothing, so Save took the overwrite route
   * and wrote to a **relative** path, which resolves against the main process's working
   * directory: the document was written somewhere other than where it came from, and reported as
   * saved (Tony, 2026-09-11).
   *
   * This is a DOM drop rather than a native one — Playwright cannot drag from the desktop — but it
   * is the same handler, reached the same way, with a real `File` carrying real bytes.
   */
  test('arrives with no path, so Save cannot overwrite the wrong file', async () => {
    // No `closeAll` here: this spec shares one app, and closing the last tab takes the window
    // with it, which ends the run. The drop opens a new tab and makes it active, which is enough.
    const bytes = [...readFileSync(join(process.cwd(), 'test', 'fixtures', 'multipage.pdf'))];
    const dropped = await app.page.evaluate((data) => {
      const file = new File([new Uint8Array(data)], 'multipage.pdf', { type: 'application/pdf' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      // The handler is on `#app`, which the shell is mounted into — dispatching on `body` would
      // never reach it, because events bubble up rather than down.
      const root = document.getElementById('app');
      if (!root) throw new Error('#app is not mounted');
      const event = new DragEvent('drop', {
        dataTransfer: transfer,
        bubbles: true,
        cancelable: true,
      });
      root.dispatchEvent(event);
      // `defaultPrevented` is how we know the shell's handler actually ran: it calls
      // `preventDefault()` as soon as it sees a PDF among the dropped files.
      return { files: transfer.files.length, handled: event.defaultPrevented };
    }, bytes);
    expect(dropped.files, 'the test never built a File to drop').toBe(1);
    expect(dropped.handled, 'the shell never handled the drop').toBe(true);

    await expect
      .poll(
        async () =>
          ((await app.run('dev.saveState').catch(() => null)) as { title: string } | null)?.title ??
          '',
        {
          timeout: 20_000,
          message: 'the dropped PDF never opened',
        },
      )
      // The title is the PDF's own, "Multi-page" — not the file name.
      .toMatch(/multi-?page/i);

    const state = (await app.run('dev.saveState')) as { path: string | null };
    expect(state.path, 'a dropped file must not be given its own name as a path').not.toBe(
      'multipage.pdf',
    );
    expect(state.path ?? '', 'a dropped file has no path at all').toBe('');
  });
});
