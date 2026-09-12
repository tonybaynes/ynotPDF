/**
 * M92's settings. The schema is declared on the manifest so M130's preferences dialog renders it;
 * this file is the typed reader/writer the service uses.
 *
 * Same shape as M40's and M41's: a key map, a default for everything, and a reader that falls
 * back rather than throwing — a hand-edited settings file must never stop the app opening a
 * document. Every value here is also what a dialog opens with, so "the last thing I chose" is a
 * setting rather than a hidden memory.
 */

import { hasBridge, invoke } from '@shared/ipc';
import type { SettingsSchema } from '@shared/module';
import type { ColourMode, Dither } from '@engine/export/pixels';
import type { ImageFormat } from '@engine/export/images';
import type { TiffCompression } from '@engine/export/codecs/tiff';
import type { LineEnding, PageSeparator, TextEncoding } from '@engine/export/text';
import type { HtmlLayout } from '@engine/export/html';
import { DEFAULT_IMAGE_PATTERN } from '@engine/export/naming';
import { DEFAULT_EMBEDDED_PATTERN, DEFAULT_MIN_PIXELS } from '@engine/export/embedded';

export interface ExportSettings {
  // ---- images ----
  readonly imageFormat: ImageFormat;
  readonly imageDpi: number;
  readonly imageColour: ColourMode;
  readonly imageDither: Dither;
  readonly monoThreshold: number;
  readonly jpegQuality: number;
  readonly compressionLevel: number;
  readonly tiffCompression: TiffCompression;
  readonly tiffMultiPage: boolean;
  readonly imageNamePattern: string;
  readonly imageAnnotations: boolean;
  readonly imageForms: boolean;
  // ---- embedded images ----
  readonly embeddedNamePattern: string;
  readonly embeddedMinPixels: number;
  readonly embeddedKeepDuplicates: boolean;
  // ---- text ----
  readonly textEncoding: TextEncoding;
  readonly textLineEnding: LineEnding;
  readonly textPageSeparator: PageSeparator;
  readonly textBom: boolean;
  // ---- html ----
  readonly htmlLayout: HtmlLayout;
  readonly htmlPerPage: boolean;
  readonly htmlEmbedImages: boolean;
  readonly htmlKeepStyles: boolean;
  // ---- rtf ----
  readonly rtfPageBreaks: boolean;
  readonly rtfKeepColours: boolean;
  readonly rtfKeepSizes: boolean;
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  imageFormat: 'png',
  imageDpi: 150,
  imageColour: 'colour',
  imageDither: 'floyd-steinberg',
  monoThreshold: 128,
  jpegQuality: 85,
  compressionLevel: 6,
  tiffCompression: 'deflate',
  tiffMultiPage: false,
  imageNamePattern: DEFAULT_IMAGE_PATTERN,
  imageAnnotations: true,
  imageForms: true,
  embeddedNamePattern: DEFAULT_EMBEDDED_PATTERN,
  embeddedMinPixels: DEFAULT_MIN_PIXELS,
  embeddedKeepDuplicates: false,
  textEncoding: 'utf-8',
  textLineEnding: 'lf',
  textPageSeparator: 'blank-line',
  textBom: false,
  htmlLayout: 'positioned',
  htmlPerPage: false,
  htmlEmbedImages: true,
  htmlKeepStyles: true,
  rtfPageBreaks: true,
  rtfKeepColours: true,
  rtfKeepSizes: true,
};

/** Keys as they appear in `settings.json`. */
const KEYS: Readonly<Record<keyof ExportSettings, string>> = {
  imageFormat: 'image.format',
  imageDpi: 'image.dpi',
  imageColour: 'image.colour',
  imageDither: 'image.dither',
  monoThreshold: 'image.monoThreshold',
  jpegQuality: 'image.jpegQuality',
  compressionLevel: 'image.compressionLevel',
  tiffCompression: 'image.tiffCompression',
  tiffMultiPage: 'image.tiffMultiPage',
  imageNamePattern: 'image.namePattern',
  imageAnnotations: 'image.annotations',
  imageForms: 'image.forms',
  embeddedNamePattern: 'embedded.namePattern',
  embeddedMinPixels: 'embedded.minPixels',
  embeddedKeepDuplicates: 'embedded.keepDuplicates',
  textEncoding: 'text.encoding',
  textLineEnding: 'text.lineEnding',
  textPageSeparator: 'text.pageSeparator',
  textBom: 'text.bom',
  htmlLayout: 'html.layout',
  htmlPerPage: 'html.perPage',
  htmlEmbedImages: 'html.embedImages',
  htmlKeepStyles: 'html.keepStyles',
  rtfPageBreaks: 'rtf.pageBreaks',
  rtfKeepColours: 'rtf.keepColours',
  rtfKeepSizes: 'rtf.keepSizes',
};

/** The settings key for one setting — the commands and the tests name the same string. */
export function settingKey(name: keyof ExportSettings): string {
  return `export.${KEYS[name]}`;
}

/** The choices each enumerated setting offers, shared by Preferences and the dialogs. */
export const FORMAT_OPTIONS: ReadonlyArray<{
  readonly value: ImageFormat;
  readonly label: string;
}> = [
  { value: 'png', label: 'PNG' },
  { value: 'jpeg', label: 'JPEG' },
  { value: 'tiff', label: 'TIFF' },
  { value: 'bmp', label: 'BMP' },
];

export const COLOUR_OPTIONS: ReadonlyArray<{ readonly value: ColourMode; readonly label: string }> =
  [
    { value: 'colour', label: 'Colour' },
    { value: 'grey', label: 'Greyscale' },
    { value: 'mono', label: 'Black and white (1 bit)' },
  ];

export const DITHER_OPTIONS: ReadonlyArray<{ readonly value: Dither; readonly label: string }> = [
  { value: 'floyd-steinberg', label: 'Error diffusion' },
  { value: 'none', label: 'Plain threshold' },
];

export const TIFF_COMPRESSION_OPTIONS: ReadonlyArray<{
  readonly value: TiffCompression;
  readonly label: string;
}> = [
  { value: 'deflate', label: 'Deflate' },
  { value: 'group4', label: 'CCITT Group 4' },
  { value: 'packbits', label: 'PackBits' },
  { value: 'none', label: 'None' },
];

export const ENCODING_OPTIONS: ReadonlyArray<{
  readonly value: TextEncoding;
  readonly label: string;
}> = [
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'utf-16le', label: 'UTF-16, little-endian (Windows “Unicode”)' },
  { value: 'utf-16be', label: 'UTF-16, big-endian' },
];

export const LINE_ENDING_OPTIONS: ReadonlyArray<{
  readonly value: LineEnding;
  readonly label: string;
}> = [
  { value: 'lf', label: 'Line feed (macOS, Linux)' },
  { value: 'crlf', label: 'Carriage return and line feed (Windows)' },
];

export const SEPARATOR_OPTIONS: ReadonlyArray<{
  readonly value: PageSeparator;
  readonly label: string;
}> = [
  { value: 'blank-line', label: 'A blank line' },
  { value: 'none', label: 'Nothing' },
  { value: 'rule', label: 'A horizontal rule' },
  { value: 'form-feed', label: 'A form feed (new page)' },
  { value: 'numbered', label: 'The page number' },
];

export const LAYOUT_OPTIONS: ReadonlyArray<{ readonly value: HtmlLayout; readonly label: string }> =
  [
    { value: 'positioned', label: 'Keep the layout — every line where the page put it' },
    { value: 'flowing', label: 'Flowing paragraphs — reflows, reads on a phone' },
  ];

export const DPI_PRESETS: ReadonlyArray<number> = [72, 96, 150, 200, 300, 600];

export const EXPORT_SETTINGS_SCHEMA: SettingsSchema = {
  namespace: 'export',
  title: 'Export',
  icon: 'file-output',
  order: 62,
  properties: {
    'image.format': {
      type: 'enum',
      title: 'Image format',
      description:
        'PNG keeps text sharp; JPEG suits photographs; TIFF can hold multiple pages; BMP supports older software.',
      section: 'Images',
      default: DEFAULT_EXPORT_SETTINGS.imageFormat,
      options: FORMAT_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
      live: true,
    },
    'image.dpi': {
      type: 'number',
      title: 'Resolution',
      description: 'A page is exported at its size in inches times this number of pixels.',
      section: 'Images',
      unit: 'dpi',
      min: 12,
      max: 1200,
      step: 1,
      default: DEFAULT_EXPORT_SETTINGS.imageDpi,
      live: true,
    },
    'image.colour': {
      type: 'enum',
      title: 'Colour',
      section: 'Images',
      default: DEFAULT_EXPORT_SETTINGS.imageColour,
      options: COLOUR_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
      live: true,
    },
    'image.dither': {
      type: 'enum',
      title: 'Black and white method',
      description: 'Error diffusion retains photographic shading; plain threshold suits text.',
      section: 'Images',
      advanced: true,
      default: DEFAULT_EXPORT_SETTINGS.imageDither,
      options: DITHER_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
      live: true,
    },
    'image.monoThreshold': {
      type: 'number',
      title: 'Black and white threshold',
      description: 'Anything lighter than this becomes white. 0 is black, 255 is white.',
      section: 'Images',
      advanced: true,
      min: 1,
      max: 254,
      default: DEFAULT_EXPORT_SETTINGS.monoThreshold,
      live: true,
    },
    'image.jpegQuality': {
      type: 'number',
      title: 'JPEG quality',
      section: 'Images',
      min: 1,
      max: 100,
      default: DEFAULT_EXPORT_SETTINGS.jpegQuality,
      live: true,
    },
    'image.compressionLevel': {
      type: 'number',
      title: 'PNG and TIFF compression',
      description: '0 is fastest and largest, 9 is slowest and smallest.',
      section: 'Images',
      advanced: true,
      min: 0,
      max: 9,
      default: DEFAULT_EXPORT_SETTINGS.compressionLevel,
      live: true,
    },
    'image.tiffCompression': {
      type: 'enum',
      title: 'TIFF compression',
      description:
        'CCITT Group 4 requires black and white (1-bit). Deflate and PackBits are lossless; None produces larger files.',
      section: 'Images',
      advanced: true,
      default: DEFAULT_EXPORT_SETTINGS.tiffCompression,
      options: TIFF_COMPRESSION_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
      live: true,
    },
    'image.tiffMultiPage': {
      type: 'boolean',
      title: 'Put every page in one TIFF file',
      section: 'Images',
      default: DEFAULT_EXPORT_SETTINGS.tiffMultiPage,
      live: true,
    },
    'image.namePattern': {
      type: 'string',
      title: 'Name for each page',
      description:
        'Tokens: {name}, {page}, {n}, {index}, {total}, {label}, {dpi}, {date}, {time}. Anything else is kept as it is.',
      keywords: ['file name', 'pattern', 'numbering'],
      section: 'Images',
      default: DEFAULT_EXPORT_SETTINGS.imageNamePattern,
      live: true,
    },
    'image.annotations': {
      type: 'boolean',
      title: 'Draw comments and markup on exported pages',
      section: 'Images',
      default: DEFAULT_EXPORT_SETTINGS.imageAnnotations,
      live: true,
    },
    'image.forms': {
      type: 'boolean',
      title: 'Draw form fields on exported pages',
      section: 'Images',
      default: DEFAULT_EXPORT_SETTINGS.imageForms,
      live: true,
    },
    'embedded.namePattern': {
      type: 'string',
      title: 'Name for each picture taken out of a document',
      section: 'Pictures inside a document',
      default: DEFAULT_EXPORT_SETTINGS.embeddedNamePattern,
      live: true,
    },
    'embedded.minPixels': {
      type: 'number',
      title: 'Smallest picture worth keeping',
      description: 'Anything narrower or shorter than this is a rule or a spacer, not a picture.',
      section: 'Pictures inside a document',
      unit: 'px',
      min: 1,
      max: 512,
      default: DEFAULT_EXPORT_SETTINGS.embeddedMinPixels,
      live: true,
    },
    'embedded.keepDuplicates': {
      type: 'boolean',
      title: 'Write a file for every placement, not one per picture',
      description: 'A logo on every page is one picture; turn this on to get one file per page.',
      section: 'Pictures inside a document',
      advanced: true,
      default: DEFAULT_EXPORT_SETTINGS.embeddedKeepDuplicates,
      live: true,
    },
    'text.encoding': {
      type: 'enum',
      title: 'Text encoding',
      section: 'Text',
      default: DEFAULT_EXPORT_SETTINGS.textEncoding,
      options: ENCODING_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
      live: true,
    },
    'text.lineEnding': {
      type: 'enum',
      title: 'Line endings',
      section: 'Text',
      default: DEFAULT_EXPORT_SETTINGS.textLineEnding,
      options: LINE_ENDING_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
      live: true,
    },
    'text.pageSeparator': {
      type: 'enum',
      title: 'Between pages',
      section: 'Text',
      default: DEFAULT_EXPORT_SETTINGS.textPageSeparator,
      options: SEPARATOR_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
      live: true,
    },
    'text.bom': {
      type: 'boolean',
      title: 'Start a UTF-8 file with a byte-order mark',
      description: 'Helps Excel and older Windows tools; confuses most other software.',
      section: 'Text',
      advanced: true,
      default: DEFAULT_EXPORT_SETTINGS.textBom,
      live: true,
    },
    'html.layout': {
      type: 'enum',
      title: 'HTML layout',
      section: 'HTML',
      default: DEFAULT_EXPORT_SETTINGS.htmlLayout,
      options: LAYOUT_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
      live: true,
    },
    'html.perPage': {
      type: 'boolean',
      title: 'Write one HTML file per page',
      section: 'HTML',
      default: DEFAULT_EXPORT_SETTINGS.htmlPerPage,
      live: true,
    },
    'html.embedImages': {
      type: 'boolean',
      title: 'Put the pictures inside the HTML file',
      description: 'One file that opens anywhere, rather than a folder that has to travel with it.',
      section: 'HTML',
      default: DEFAULT_EXPORT_SETTINGS.htmlEmbedImages,
      live: true,
    },
    'html.keepStyles': {
      type: 'boolean',
      title: 'Keep the document’s fonts, sizes and colours',
      section: 'HTML',
      default: DEFAULT_EXPORT_SETTINGS.htmlKeepStyles,
      live: true,
    },
    'rtf.pageBreaks': {
      type: 'boolean',
      title: 'Start each page on a new page',
      section: 'RTF',
      default: DEFAULT_EXPORT_SETTINGS.rtfPageBreaks,
      live: true,
    },
    'rtf.keepColours': {
      type: 'boolean',
      title: 'Keep the document’s text colours',
      section: 'RTF',
      default: DEFAULT_EXPORT_SETTINGS.rtfKeepColours,
      live: true,
    },
    'rtf.keepSizes': {
      type: 'boolean',
      title: 'Keep the document’s font sizes',
      section: 'RTF',
      default: DEFAULT_EXPORT_SETTINGS.rtfKeepSizes,
      live: true,
    },
  },
};

export interface SettingsStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export function ipcSettingsStorage(): SettingsStorage {
  return {
    get: async (key) => (hasBridge() ? await invoke('settings:get', key) : undefined),
    set: async (key, value) => {
      if (hasBridge()) await invoke('settings:set', key, value);
    },
  };
}

export function memorySettingsStorage(
  initial: Readonly<Record<string, unknown>> = {},
): SettingsStorage {
  const map = new Map<string, unknown>(Object.entries(initial));
  return {
    get: (key) => Promise.resolve(map.get(key)),
    set: (key, value) => {
      map.set(key, value);
      return Promise.resolve();
    },
  };
}

const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

const number = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fallback;

const text = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim() !== '' ? value : fallback;

function oneOf<T extends string>(
  value: unknown,
  options: ReadonlyArray<{ readonly value: T }>,
  fallback: T,
): T {
  return options.some((o) => o.value === value) ? (value as T) : fallback;
}

/** Reads every setting, falling back to the default for anything unset or malformed. */
export async function readExportSettings(storage: SettingsStorage): Promise<ExportSettings> {
  const names = Object.keys(KEYS) as Array<keyof ExportSettings>;
  const values = await Promise.all(names.map((name) => storage.get(settingKey(name))));
  const at = (name: keyof ExportSettings): unknown => values[names.indexOf(name)];
  const d = DEFAULT_EXPORT_SETTINGS;
  return {
    imageFormat: oneOf(at('imageFormat'), FORMAT_OPTIONS, d.imageFormat),
    imageDpi: number(at('imageDpi'), d.imageDpi, 12, 1200),
    imageColour: oneOf(at('imageColour'), COLOUR_OPTIONS, d.imageColour),
    imageDither: oneOf(at('imageDither'), DITHER_OPTIONS, d.imageDither),
    monoThreshold: number(at('monoThreshold'), d.monoThreshold, 1, 254),
    jpegQuality: number(at('jpegQuality'), d.jpegQuality, 1, 100),
    compressionLevel: number(at('compressionLevel'), d.compressionLevel, 0, 9),
    tiffCompression: oneOf(at('tiffCompression'), TIFF_COMPRESSION_OPTIONS, d.tiffCompression),
    tiffMultiPage: bool(at('tiffMultiPage'), d.tiffMultiPage),
    imageNamePattern: text(at('imageNamePattern'), d.imageNamePattern),
    imageAnnotations: bool(at('imageAnnotations'), d.imageAnnotations),
    imageForms: bool(at('imageForms'), d.imageForms),
    embeddedNamePattern: text(at('embeddedNamePattern'), d.embeddedNamePattern),
    embeddedMinPixels: number(at('embeddedMinPixels'), d.embeddedMinPixels, 1, 512),
    embeddedKeepDuplicates: bool(at('embeddedKeepDuplicates'), d.embeddedKeepDuplicates),
    textEncoding: oneOf(at('textEncoding'), ENCODING_OPTIONS, d.textEncoding),
    textLineEnding: oneOf(at('textLineEnding'), LINE_ENDING_OPTIONS, d.textLineEnding),
    textPageSeparator: oneOf(at('textPageSeparator'), SEPARATOR_OPTIONS, d.textPageSeparator),
    textBom: bool(at('textBom'), d.textBom),
    htmlLayout: oneOf(at('htmlLayout'), LAYOUT_OPTIONS, d.htmlLayout),
    htmlPerPage: bool(at('htmlPerPage'), d.htmlPerPage),
    htmlEmbedImages: bool(at('htmlEmbedImages'), d.htmlEmbedImages),
    htmlKeepStyles: bool(at('htmlKeepStyles'), d.htmlKeepStyles),
    rtfPageBreaks: bool(at('rtfPageBreaks'), d.rtfPageBreaks),
    rtfKeepColours: bool(at('rtfKeepColours'), d.rtfKeepColours),
    rtfKeepSizes: bool(at('rtfKeepSizes'), d.rtfKeepSizes),
  };
}

export async function writeExportSetting<K extends keyof ExportSettings>(
  storage: SettingsStorage,
  name: K,
  value: ExportSettings[K],
): Promise<void> {
  await storage.set(settingKey(name), value);
}

/** Writes several at once — what a dialog does when the reader presses Export. */
export async function writeExportSettings(
  storage: SettingsStorage,
  patch: Partial<ExportSettings>,
): Promise<void> {
  const names = Object.keys(patch) as Array<keyof ExportSettings>;
  await Promise.all(
    names.map(async (name) => {
      const value = patch[name];
      if (value !== undefined) await storage.set(settingKey(name), value);
    }),
  );
}

/** Explanations wrap below the native choices instead of being cut off inside them. */
export const FORMAT_HINTS: Readonly<Record<ImageFormat, string>> = {
  png: 'Lossless compression keeps text sharp.',
  jpeg: 'Smaller files, best suited to photographs.',
  tiff: 'Lossless output that can hold every page in one file.',
  bmp: 'Uncompressed output for older software.',
};
export const DITHER_HINTS: Readonly<Record<Dither, string>> = {
  'floyd-steinberg': 'Spreads black and white dots to retain shading in photographs.',
  none: 'Uses a single brightness cutoff, best suited to text.',
};
export const TIFF_COMPRESSION_HINTS: Readonly<Record<TiffCompression, string>> = {
  deflate: 'Lossless compression for colour, greyscale or black and white.',
  group4: 'Lossless compression for black and white (1-bit) pages only.',
  packbits: 'Lossless compression with wide software support.',
  none: 'No compression; produces the largest files.',
};
