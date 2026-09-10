/**
 * The optimise presets (M100).
 *
 * The four built-in ones are data — `resources/optimise-presets.json`, per PLAN.md §4.4 — and
 * this file is the typed reader. It validates on the way in rather than trusting the shape,
 * because the same reader also parses the presets a reader saved into their own settings, and a
 * hand-edited settings file must never stop the dialog opening.
 */

import file from '../../../resources/optimise-presets.json';
import type {
  DedupeOptions,
  DiscardOptions,
  FontOptions,
  ImageCodec,
  ImageOptions,
  ImagePolicy,
  OptimiseOptions,
  OptimisePreset,
  StructureOptions,
} from './types';

const CODECS: ReadonlyArray<ImageCodec> = ['keep', 'jpeg', 'flate', 'ccitt'];

/** What a preset falls back to for anything it does not say: change nothing. */
export const NO_CHANGE: OptimiseOptions = {
  images: {
    colour: { targetDpi: 0, thresholdDpi: 0, codec: 'keep', quality: 100 },
    grey: { targetDpi: 0, thresholdDpi: 0, codec: 'keep', quality: 100 },
    mono: { targetDpi: 0, thresholdDpi: 0, codec: 'keep', quality: 100 },
    neverGrow: true,
  },
  fonts: { subset: false, unembedStandard: false },
  discard: {
    thumbnails: false,
    alternateImages: false,
    metadata: false,
    bookmarks: false,
    links: false,
    comments: false,
    forms: false,
    embeddedFiles: false,
    javascript: false,
    privateData: false,
  },
  structure: {
    objectStreams: false,
    recompressStreams: false,
    removeUnused: false,
    linearise: false,
  },
  dedupe: { images: false, fonts: false, xobjects: false },
};

/** The four that ship with the app, in the order the dialog lists them. */
export const BUILT_IN_PRESETS: ReadonlyArray<OptimisePreset> = readPresets(file);

/** The one a fresh installation starts on. */
export const DEFAULT_PRESET_ID = 'standard';

export function presetById(
  id: string,
  extra: ReadonlyArray<OptimisePreset> = [],
): OptimisePreset | null {
  return [...BUILT_IN_PRESETS, ...extra].find((p) => p.id === id) ?? null;
}

/**
 * True when these options cannot change a single rendered pixel: no image is resampled or
 * re-encoded, no font program is cut, and nothing is discarded. Structural work and duplicate
 * merging are both exactly lossless, so they do not count against it.
 *
 * Computed rather than trusted from the file, so a preset the reader edited answers honestly.
 */
export function isLossless(options: OptimiseOptions): boolean {
  const images = [options.images.colour, options.images.grey, options.images.mono];
  if (images.some((p) => p.codec !== 'keep' || p.targetDpi > 0)) return false;
  if (options.fonts.subset || options.fonts.unembedStandard) return false;
  return !Object.values(options.discard).some(Boolean);
}

// ---- parsing ---------------------------------------------------------------------------------

function readPresets(raw: unknown): OptimisePreset[] {
  const list = isRecord(raw) && Array.isArray(raw['presets']) ? raw['presets'] : [];
  const out: OptimisePreset[] = [];
  for (const entry of list) {
    const preset = readPreset(entry, true);
    if (preset) out.push(preset);
  }
  return out;
}

/** Reads one preset, from the resource file or from a reader's settings. `null` when unusable. */
export function readPreset(raw: unknown, builtIn = false): OptimisePreset | null {
  if (!isRecord(raw)) return null;
  const id = str(raw['id'], '');
  const name = str(raw['name'], '');
  if (id === '' || name === '') return null;
  const options = readOptions(raw['options']);
  return {
    id,
    name,
    description: str(raw['description'], ''),
    lossless: isLossless(options),
    builtIn,
    options,
  };
}

export function readOptions(raw: unknown): OptimiseOptions {
  if (!isRecord(raw)) return NO_CHANGE;
  return {
    images: readImages(raw['images']),
    fonts: readFonts(raw['fonts']),
    discard: readFlags(raw['discard'], NO_CHANGE.discard),
    structure: readFlags(raw['structure'], NO_CHANGE.structure),
    dedupe: readFlags(raw['dedupe'], NO_CHANGE.dedupe),
  };
}

function readImages(raw: unknown): ImageOptions {
  const record = isRecord(raw) ? raw : {};
  return {
    colour: readPolicy(record['colour'], NO_CHANGE.images.colour),
    grey: readPolicy(record['grey'], NO_CHANGE.images.grey),
    mono: readPolicy(record['mono'], NO_CHANGE.images.mono),
    neverGrow: bool(record['neverGrow'], true),
  };
}

function readPolicy(raw: unknown, fallback: ImagePolicy): ImagePolicy {
  const record = isRecord(raw) ? raw : {};
  const codec = record['codec'];
  return {
    targetDpi: num(record['targetDpi'], fallback.targetDpi, 0, 2400),
    thresholdDpi: num(record['thresholdDpi'], fallback.thresholdDpi, 0, 2400),
    codec: CODECS.includes(codec as ImageCodec) ? (codec as ImageCodec) : fallback.codec,
    quality: num(record['quality'], fallback.quality, 1, 100),
  };
}

function readFonts(raw: unknown): FontOptions {
  const record = isRecord(raw) ? raw : {};
  return {
    subset: bool(record['subset'], false),
    unembedStandard: bool(record['unembedStandard'], false),
  };
}

/** A record of booleans, keyed by whatever the fallback has: unknown keys are simply ignored. */
function readFlags<T extends DiscardOptions | StructureOptions | DedupeOptions>(
  raw: unknown,
  fallback: T,
): T {
  const record = isRecord(raw) ? raw : {};
  const defaults = fallback as unknown as Record<string, boolean>;
  const out: Record<string, boolean> = {};
  for (const key of Object.keys(defaults)) out[key] = bool(record[key], defaults[key] ?? false);
  return out as unknown as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}
