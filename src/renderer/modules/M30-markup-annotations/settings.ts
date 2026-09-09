/**
 * M30's settings: who the author is, whether a tool stays selected after it has been used, and
 * the default properties of every annotation tool ("Set as default" in Foxit's properties panel).
 *
 * All of it goes through the settings IPC (ADR 0003) under `annot.*` and `identity.*`. The tool
 * defaults are one stored object per tool rather than a key per property: they are only ever read
 * and written together, and a half-migrated set of defaults would be worse than the defaults.
 */

import { hasBridge, invoke } from '@shared/ipc';
import type { SettingsSchema } from '@shared/module';
import { DEFAULT_NOTE_ICON } from '@engine/appearance';
import { defaultColourFor } from './presets';

/** The tools that create an annotation. The id is also the settings key and the command suffix. */
export const ANNOTATION_TOOLS = [
  'highlight',
  'underline',
  'squiggly',
  'strikeout',
  'replace',
  'insert',
  'note',
  'typewriter',
  'textbox',
  'callout',
] as const;

export type AnnotationToolId = (typeof ANNOTATION_TOOLS)[number];

/** Every property a tool's default can carry. Which ones matter depends on the tool. */
export interface ToolDefaults {
  /** Stroke, text or highlight colour, `0xRRGGBB`. */
  readonly color: number;
  /** Interior colour, or null for none. */
  readonly fillColor: number | null;
  readonly borderWidth: number;
  readonly borderStyle: 'solid' | 'dashed';
  /** Sticky-note icon (`/Name`). */
  readonly icon: string;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly bold: boolean;
  readonly italic: boolean;
  /** `/Q`: 0 left, 1 centre, 2 right. */
  readonly align: 0 | 1 | 2;
  readonly lineSpacing: number;
  /** Subject line (`/Subj`) — Foxit fills it with the tool's own name. */
  readonly subject: string;
}

const BASE: Omit<ToolDefaults, 'color' | 'subject'> = {
  fillColor: null,
  borderWidth: 1,
  borderStyle: 'solid',
  icon: DEFAULT_NOTE_ICON,
  fontFamily: 'Helvetica',
  fontSize: 12,
  bold: false,
  italic: false,
  align: 0,
  lineSpacing: 1.2,
};

const SUBJECTS: Readonly<Record<AnnotationToolId, string>> = {
  highlight: 'Highlight',
  underline: 'Underline',
  squiggly: 'Squiggly',
  strikeout: 'Strikeout',
  replace: 'Replace Text',
  insert: 'Insert Text',
  note: 'Note',
  typewriter: 'Typewriter',
  textbox: 'Text Box',
  callout: 'Callout',
};

/** The factory defaults for one tool. */
export function factoryDefaults(tool: AnnotationToolId): ToolDefaults {
  const color = defaultColourFor(tool);
  const base: ToolDefaults = { ...BASE, color, subject: SUBJECTS[tool] };
  switch (tool) {
    case 'typewriter':
      // A typewriter is text on the page and nothing else: no border, no fill, ever.
      return { ...base, borderWidth: 0 };
    case 'textbox':
      return { ...base, fillColor: 0xffffff, borderWidth: 1 };
    case 'callout':
      return { ...base, fillColor: 0xffffff, borderWidth: 1 };
    default:
      return base;
  }
}

/** Settings that are not per tool. */
export interface AnnotationSettings {
  /** Foxit's "Keep Tool Selected": a tool stays active after it has made an annotation. */
  readonly keepToolSelected: boolean;
  /** Open the note popup as soon as a note is placed. */
  readonly openPopupOnCreate: boolean;
  /** Show a tooltip with the author and date when the pointer rests on an annotation. */
  readonly showTooltips: boolean;
  /** Nudge distance for the arrow keys, in points. Shift multiplies it by ten. */
  readonly nudgePoints: number;
}

export const DEFAULT_ANNOTATION_SETTINGS: AnnotationSettings = {
  keepToolSelected: false,
  openPopupOnCreate: true,
  showTooltips: true,
  nudgePoints: 1,
};

/** Who the annotations say they are by. Asked for once, on the first annotation. */
export interface Identity {
  readonly name: string;
  readonly initials: string;
  readonly email: string;
  /** False until the reader has been asked, which is what triggers the dialog. */
  readonly asked: boolean;
}

export const EMPTY_IDENTITY: Identity = { name: '', initials: '', email: '', asked: false };

const KEYS: Readonly<Record<keyof AnnotationSettings, string>> = {
  keepToolSelected: 'annot.keepToolSelected',
  openPopupOnCreate: 'annot.openPopupOnCreate',
  showTooltips: 'annot.showTooltips',
  nudgePoints: 'annot.nudgePoints',
};

const IDENTITY_KEYS: Readonly<Record<keyof Identity, string>> = {
  name: 'identity.name',
  initials: 'identity.initials',
  email: 'identity.email',
  asked: 'identity.asked',
};

const defaultsKey = (tool: AnnotationToolId): string => `annot.defaults.${tool}`;

/** Where a setting is read from and written to. Tests pass a memory implementation. */
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

export async function readSettings(storage: SettingsStorage): Promise<AnnotationSettings> {
  const names = Object.keys(KEYS) as Array<keyof AnnotationSettings>;
  const entries = await Promise.all(
    names.map(async (name) => [name, await storage.get(KEYS[name])] as const),
  );
  const out: Record<string, unknown> = { ...DEFAULT_ANNOTATION_SETTINGS };
  for (const [name, value] of entries) {
    if (value === undefined || value === null) continue;
    if (typeof value === typeof DEFAULT_ANNOTATION_SETTINGS[name]) out[name] = value;
  }
  return out as unknown as AnnotationSettings;
}

export async function writeSetting<K extends keyof AnnotationSettings>(
  storage: SettingsStorage,
  name: K,
  value: AnnotationSettings[K],
): Promise<void> {
  await storage.set(KEYS[name], value);
}

export async function readIdentity(storage: SettingsStorage): Promise<Identity> {
  const [name, initials, email, asked] = await Promise.all([
    storage.get(IDENTITY_KEYS.name),
    storage.get(IDENTITY_KEYS.initials),
    storage.get(IDENTITY_KEYS.email),
    storage.get(IDENTITY_KEYS.asked),
  ]);
  return {
    name: typeof name === 'string' ? name : '',
    initials: typeof initials === 'string' ? initials : '',
    email: typeof email === 'string' ? email : '',
    asked: asked === true,
  };
}

export async function writeIdentity(storage: SettingsStorage, identity: Identity): Promise<void> {
  await Promise.all([
    storage.set(IDENTITY_KEYS.name, identity.name),
    storage.set(IDENTITY_KEYS.initials, identity.initials),
    storage.set(IDENTITY_KEYS.email, identity.email),
    storage.set(IDENTITY_KEYS.asked, identity.asked),
  ]);
}

/** Initials from a name — "Tony Baynes" → "TB" — which is what the dialog offers. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  // `charAt` rather than a spread: a name may begin with a character outside the BMP, and the
  // point here is one initial per word, not one code point.
  const letters = words.map((w) => w.slice(0, 2).charAt(0));
  return (letters.length <= 3 ? letters : [letters[0], letters[letters.length - 1]])
    .join('')
    .toUpperCase();
}

export async function readToolDefaults(
  storage: SettingsStorage,
  tool: AnnotationToolId,
): Promise<ToolDefaults> {
  return mergeToolDefaults(tool, await storage.get(defaultsKey(tool)));
}

/**
 * Merges a stored object over the factory defaults, field by field. A stored set from an older
 * version is merged rather than rejected, and a field of the wrong type is ignored — the same
 * rule M13 uses for its print settings, and for the same reason.
 */
export function mergeToolDefaults(tool: AnnotationToolId, raw: unknown): ToolDefaults {
  const base = factoryDefaults(tool);
  if (!raw || typeof raw !== 'object') return base;
  const source = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(base) as Array<keyof ToolDefaults>) {
    const value = source[key];
    if (value === undefined) continue;
    if (key === 'fillColor') {
      if (value === null || typeof value === 'number') out[key] = value;
      continue;
    }
    if (typeof value === typeof base[key]) out[key] = value;
  }
  return out as unknown as ToolDefaults;
}

export async function writeToolDefaults(
  storage: SettingsStorage,
  tool: AnnotationToolId,
  defaults: ToolDefaults,
): Promise<void> {
  await storage.set(defaultsKey(tool), defaults);
}

/** The manifest's settings schema — what M130's preferences dialog renders. */
export const ANNOTATION_SETTINGS_SCHEMA: SettingsSchema = {
  namespace: 'annot',
  properties: {
    keepToolSelected: {
      type: 'boolean',
      title: 'Keep an annotation tool selected after using it',
      default: DEFAULT_ANNOTATION_SETTINGS.keepToolSelected,
    },
    openPopupOnCreate: {
      type: 'boolean',
      title: 'Open the note popup as soon as a note is placed',
      default: DEFAULT_ANNOTATION_SETTINGS.openPopupOnCreate,
    },
    showTooltips: {
      type: 'boolean',
      title: 'Show the author and date when the pointer rests on an annotation',
      default: DEFAULT_ANNOTATION_SETTINGS.showTooltips,
    },
    nudgePoints: {
      type: 'number',
      title: 'Arrow-key nudge distance (points; Shift moves ten times as far)',
      default: DEFAULT_ANNOTATION_SETTINGS.nudgePoints,
      min: 0.25,
      max: 20,
      step: 0.25,
    },
  },
};
