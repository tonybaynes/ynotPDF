/**
 * The interface font (M130).
 *
 * The operator has low vision, and which typeface is easiest to read is personal — one person
 * reads DejaVu's larger x-height comfortably where another prefers the system face they already
 * know. So the choice is a real one, and it is drawn from fonts the installer already carries:
 * the Liberation and DejaVu families M10 fetches for PDF substitution (OFL / Bitstream Vera,
 * already credited). No new package, no new download.
 *
 * Loading follows `src/engine/worker-assets.ts`: `import.meta.glob` with `?inline`, because
 * `fetch()` of a `file://` URL fails in the packaged app. A build whose fonts have not been
 * fetched finds nothing in the glob and falls back to the option's CSS stack, which always ends
 * in a generic family — so the worst case is "it looks like the system font", never a blank UI.
 */

import catalogue from '../../../../resources/ui-fonts.json';

export interface UiFontFaces {
  readonly regular: string;
  readonly bold: string;
  readonly italic: string;
  readonly boldItalic: string;
}

export interface UiFontOption {
  readonly id: string;
  readonly label: string;
  readonly note?: string;
  /** The `font-family` name the bundled faces are registered under; `null` for the system font. */
  readonly family: string | null;
  readonly files: UiFontFaces | null;
  /** CSS families used when the bundled face is missing, and for glyphs it does not have. */
  readonly stack: string;
}

interface UiFontCatalogue {
  readonly version: number;
  readonly fonts: ReadonlyArray<UiFontOption>;
}

export const UI_FONTS = (catalogue as unknown as UiFontCatalogue).fonts;

export const DEFAULT_UI_FONT = 'system';

/**
 * The last-resort option: what an unknown id resolves to, and what a build with an empty or
 * broken catalogue still has to offer. Written out rather than taken from `UI_FONTS[0]` so the
 * fallback cannot itself be missing.
 */
export const SYSTEM_FONT: UiFontOption = {
  id: DEFAULT_UI_FONT,
  label: 'System default',
  family: null,
  files: null,
  stack: "system-ui, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
};

export function uiFont(id: string): UiFontOption {
  return UI_FONTS.find((f) => f.id === id) ?? SYSTEM_FONT;
}

export function isUiFont(value: unknown): value is string {
  return typeof value === 'string' && UI_FONTS.some((f) => f.id === value);
}

/** The value `--font-ui` is set to. Pure, so the tests can assert it without a document. */
export function fontStack(option: UiFontOption): string {
  return option.family ? `'${option.family}', ${option.stack}` : option.stack;
}

const fontModules = import.meta.glob('../../../../resources/fonts/*.ttf', {
  query: '?inline',
  import: 'default',
}) as Record<string, () => Promise<string>>;

function moduleFor(fileName: string): (() => Promise<string>) | undefined {
  for (const [path, load] of Object.entries(fontModules)) {
    if (path.endsWith(`/${fileName}`)) return load;
  }
  return undefined;
}

const registered = new Set<string>();

/**
 * Registers the bundled faces for one option with the document. Resolves once they are usable
 * (or immediately, when there is nothing to register). Faces that fail to load are skipped
 * individually: a missing italic must not cost the reader the regular weight.
 */
export async function loadUiFont(option: UiFontOption): Promise<void> {
  const { family, files } = option;
  if (!family || !files || registered.has(option.id)) return;
  if (typeof document === 'undefined' || typeof FontFace === 'undefined') return;
  registered.add(option.id);
  const faces: ReadonlyArray<{ file: string; weight: string; style: string }> = [
    { file: files.regular, weight: '400', style: 'normal' },
    { file: files.bold, weight: '700', style: 'normal' },
    { file: files.italic, weight: '400', style: 'italic' },
    { file: files.boldItalic, weight: '700', style: 'italic' },
  ];
  await Promise.all(
    faces.map(async ({ file, weight, style }) => {
      const load = moduleFor(file);
      if (!load) return;
      try {
        const dataUrl = await load();
        const face = new FontFace(family, `url(${dataUrl})`, { weight, style });
        await face.load();
        document.fonts.add(face);
      } catch (error) {
        console.warn(`ui font: ${file} could not be loaded`, error);
      }
    }),
  );
}

/**
 * Applies the chosen font: loads its faces, then sets `--font-ui` on `<html>`. The variable is
 * set first so the stack's fallback is in use while the faces load, rather than the previous
 * font staying on screen until they arrive.
 */
export async function applyUiFont(id: string, root?: HTMLElement): Promise<UiFontOption> {
  const option = uiFont(id);
  const element = root ?? (typeof document === 'undefined' ? undefined : document.documentElement);
  element?.style.setProperty('--font-ui', fontStack(option));
  await loadUiFont(option);
  return option;
}
