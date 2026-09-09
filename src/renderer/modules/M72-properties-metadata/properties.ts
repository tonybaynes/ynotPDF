/**
 * What the Properties dialog reads and writes, as plain data (M72).
 *
 * Two shapes: {@link DocumentProperties} is everything the Description, Custom and Advanced tabs
 * show, and {@link InitialViewSettings} is the Initial View tab. Both are derived from the model
 * and turned back into a patch by the commands in `commands.ts`; nothing here touches a
 * `Document` or the DOM, so the mapping is unit-testable on its own.
 */

import type { ModelId } from '@core/Ids';
import type { ModelMetadata, ViewSettings } from '@core/model';
import type { Document } from '@core/Document';

/** The Description, Custom and Advanced tabs, as one editable record. */
export interface DocumentProperties {
  readonly title: string;
  readonly author: string;
  readonly subject: string;
  readonly keywords: string;
  /** `/Creator` — the application the document was authored in. */
  readonly creator: string;
  /** `/Producer` — the application that wrote the PDF. */
  readonly producer: string;
  /** Custom information-dictionary entries, in the order the dialog shows them. */
  readonly custom: ReadonlyArray<CustomProperty>;
  readonly trapped: 'True' | 'False' | 'Unknown' | null;
  readonly lang: string;
  readonly baseUrl: string;
}

export interface CustomProperty {
  readonly name: string;
  readonly value: string;
}

/** The Initial View tab. `initialPageId` is a model page id so a reorder carries it along. */
export interface InitialViewSettings {
  readonly pageMode: ViewSettings['pageMode'];
  readonly pageLayout: ViewSettings['pageLayout'];
  readonly initialPageId: ModelId | null;
  readonly initialFit: ViewSettings['initialFit'];
  readonly initialZoom: number | null;
  readonly hideToolbar: boolean;
  readonly hideMenubar: boolean;
  readonly hideWindowUi: boolean;
  readonly fitWindow: boolean;
  readonly centreWindow: boolean;
  readonly displayDocTitle: boolean;
  readonly printScaling: ViewSettings['printScaling'];
  readonly direction: ViewSettings['direction'];
}

/** The document's properties as the dialog should show them. */
export function readProperties(doc: Document): DocumentProperties {
  const m = doc.state.metadata;
  return {
    title: m.title ?? '',
    author: m.author ?? '',
    subject: m.subject ?? '',
    keywords: m.keywords ?? '',
    creator: m.creator ?? '',
    producer: m.producer ?? '',
    custom: Object.entries(m.custom)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    trapped: m.trapped,
    lang: m.lang ?? '',
    baseUrl: m.baseUrl ?? '',
  };
}

export function readInitialView(doc: Document): InitialViewSettings {
  const v = doc.state.view;
  return {
    pageMode: v.pageMode,
    pageLayout: v.pageLayout,
    initialPageId: v.initialPageId,
    initialFit: v.initialFit,
    initialZoom: v.initialZoom,
    hideToolbar: v.hideToolbar,
    hideMenubar: v.hideMenubar,
    hideWindowUi: v.hideWindowUi,
    fitWindow: v.fitWindow,
    centreWindow: v.centreWindow,
    displayDocTitle: v.displayDocTitle,
    printScaling: v.printScaling,
    direction: v.direction,
  };
}

/**
 * The metadata patch that turns the document's current properties into `next`.
 *
 * An empty string means "remove the entry", not "set it to nothing": a `/Title ()` in a file is
 * a title that some viewers show as a blank line, which is not what clearing a box means.
 * Returns `null` when nothing differs, so pressing OK on an untouched dialog is not an edit.
 */
export function propertiesPatch(
  current: DocumentProperties,
  next: DocumentProperties,
): Partial<ModelMetadata> | null {
  const patch: Record<string, unknown> = {};
  for (const key of ['title', 'author', 'subject', 'keywords', 'creator', 'producer'] as const) {
    if (current[key] !== next[key]) patch[key] = next[key] === '' ? null : next[key];
  }
  if (current.trapped !== next.trapped) patch['trapped'] = next.trapped;
  if (current.lang !== next.lang) patch['lang'] = next.lang === '' ? null : next.lang;
  if (current.baseUrl !== next.baseUrl) {
    patch['baseUrl'] = next.baseUrl === '' ? null : next.baseUrl;
  }
  const custom = customRecord(next.custom);
  if (!sameRecord(customRecord(current.custom), custom)) patch['custom'] = custom;
  return Object.keys(patch).length === 0 ? null : patch;
}

/** The view patch that turns the current settings into `next`, or null when they are the same. */
export function viewPatch(
  current: InitialViewSettings,
  next: InitialViewSettings,
): Partial<ViewSettings> | null {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(next) as Array<keyof InitialViewSettings>) {
    if (current[key] !== next[key]) patch[key] = next[key];
  }
  return Object.keys(patch).length === 0 ? null : patch;
}

/** Custom properties as the model holds them: a record, with blank names dropped. */
export function customRecord(
  properties: ReadonlyArray<CustomProperty>,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const p of properties) {
    const name = p.name.trim();
    if (name !== '') out[name] = p.value;
  }
  return out;
}

function sameRecord(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => a[k] === b[k]);
}

/**
 * Why a custom property name cannot be used, or null when it can.
 *
 * The reserved names are the information dictionary's own keys: a custom property called
 * "Title" would fight with the Description tab over the same entry, and the file would end up
 * with whichever was written last.
 */
export function customNameProblem(
  name: string,
  existing: ReadonlyArray<CustomProperty>,
  index: number,
): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return 'A property needs a name.';
  if (RESERVED_NAMES.has(trimmed)) {
    return `"${trimmed}" is one of the standard properties — use the Description tab for it.`;
  }
  if (existing.some((p, i) => i !== index && p.name.trim() === trimmed)) {
    return `There is already a property called "${trimmed}".`;
  }
  return null;
}

const RESERVED_NAMES: ReadonlySet<string> = new Set([
  'Title',
  'Author',
  'Subject',
  'Keywords',
  'Creator',
  'Producer',
  'CreationDate',
  'ModDate',
  'Trapped',
]);
