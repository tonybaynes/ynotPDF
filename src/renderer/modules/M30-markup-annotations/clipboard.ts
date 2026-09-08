/**
 * Annotations on the clipboard (M30). Pure: a string in, a list out.
 *
 * The payload is plain text, not a custom MIME type, and it begins with a marker line. That is a
 * deliberate trade: a custom flavour would be invisible to every other application, whereas this
 * pastes into another window of the app as annotations *and* into a text editor as something a
 * reader can at least recognise — the marker, then readable JSON.
 *
 * Nothing here trusts what it reads. The clipboard is shared with every application on the
 * machine, so a payload is validated field by field and anything that does not look like an
 * annotation is dropped rather than fixed up.
 */

import type { ModelAnnotation } from '@core/model';
import type { PdfRect } from '@shared/pdf';

/** The first line of the payload; the rest is JSON. */
export const CLIPBOARD_MARKER = 'ynotPDF annotations v1';

/** One annotation on the clipboard, with the page it came from. */
export interface ClipboardAnnotation {
  readonly annotation: ModelAnnotation;
  readonly page: number;
}

/** The clipboard text for a list of annotations. */
export function encodeAnnotations(items: ReadonlyArray<ClipboardAnnotation>): string {
  const payload = items.map((item) => ({
    page: item.page,
    subtype: item.annotation.subtype,
    rect: item.annotation.rect,
    flags: item.annotation.flags,
    contents: item.annotation.contents,
    author: item.annotation.author,
    subject: item.annotation.subject,
    color: item.annotation.color,
    interiorColor: item.annotation.interiorColor,
    opacity: item.annotation.opacity,
    borderWidth: item.annotation.borderWidth,
    quadPoints: 'quadPoints' in item.annotation ? item.annotation.quadPoints : undefined,
    paths: 'paths' in item.annotation ? item.annotation.paths : undefined,
    vertices: 'vertices' in item.annotation ? item.annotation.vertices : undefined,
    extra: item.annotation.extra,
  }));
  return `${CLIPBOARD_MARKER}\n${JSON.stringify(payload, null, 1)}`;
}

/** Whether a clipboard string is one of ours at all — cheap enough for a `when` clause. */
export function looksLikeAnnotations(text: string): boolean {
  return text.startsWith(CLIPBOARD_MARKER);
}

/** The annotations in a clipboard string. Anything unusable is dropped, never repaired. */
export function decodeAnnotations(text: string): ClipboardAnnotation[] {
  if (!looksLikeAnnotations(text)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(CLIPBOARD_MARKER.length));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ClipboardAnnotation[] = [];
  for (const raw of parsed) {
    const item = decodeOne(raw);
    if (item) out.push(item);
  }
  return out;
}

function decodeOne(raw: unknown): ClipboardAnnotation | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const subtype = r['subtype'];
  const rect = decodeRect(r['rect']);
  if (typeof subtype !== 'string' || !rect) return null;
  const flags = r['flags'];
  const annotation = {
    id: '',
    pageId: '',
    subtype,
    rect,
    flags:
      flags && typeof flags === 'object'
        ? (flags as ModelAnnotation['flags'])
        : { hidden: false, print: true, noView: false, readOnly: false, locked: false },
    contents: str(r['contents']),
    author: str(r['author']),
    created: null,
    modified: null,
    color: num(r['color']),
    interiorColor: num(r['interiorColor']),
    // A pasted annotation keeps whatever `/CA` the file it came from had; the app still writes
    // none of its own.
    opacity: num(r['opacity']),
    borderWidth: num(r['borderWidth']),
    appearanceState: null,
    name: null,
    subject: str(r['subject']),
    inReplyTo: null,
    state: null,
    extra: plainObject(r['extra']),
    quadPoints: numbers(r['quadPoints']),
    paths: pathList(r['paths']),
    vertices: points(r['vertices']),
  } as unknown as ModelAnnotation;
  const page = r['page'];
  return { annotation, page: typeof page === 'number' && page >= 0 ? Math.floor(page) : 0 };
}

function decodeRect(value: unknown): PdfRect | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  const numbersOnly = ['x0', 'y0', 'x1', 'y1'].map((k) => r[k]);
  if (!numbersOnly.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  const [x0, y0, x1, y1] = numbersOnly as [number, number, number, number];
  return { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function numbers(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    : [];
}

function points(value: unknown): Array<{ x: number; y: number }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ x: number; y: number }> = [];
  for (const p of value) {
    if (!p || typeof p !== 'object') continue;
    const q = p as Record<string, unknown>;
    if (typeof q['x'] === 'number' && typeof q['y'] === 'number') {
      out.push({ x: q['x'], y: q['y'] });
    }
  }
  return out;
}

function pathList(value: unknown): Array<Array<{ x: number; y: number }>> {
  return Array.isArray(value) ? value.map(points).filter((p) => p.length > 0) : [];
}

/** A shallow copy of a JSON object, with anything that is not a JSON value dropped. */
function plainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const ok =
      item === null ||
      typeof item === 'string' ||
      typeof item === 'number' ||
      typeof item === 'boolean' ||
      (Array.isArray(item) && item.every((n) => typeof n === 'number' || typeof n === 'string'));
    // `hasAP` describes the file the annotation came from, not the annotation: a paste starts
    // without an appearance stream whatever the source had.
    if (ok && key !== 'hasAP') out[key] = item;
  }
  return out;
}
