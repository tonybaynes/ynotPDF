/**
 * Decoration presets (M53).
 *
 * The ones that ship are data — `resources/presets/decorations.json`, per PLAN.md §4.4 — and this
 * file is the typed reader. It validates on the way in rather than trusting the shape, because
 * the same reader also parses the presets a reader saved into their own settings, and a
 * hand-edited settings file must never stop a dialog opening.
 */

import file from '../../../../resources/presets/decorations.json';
import type { DecorationKind, DecorationSpec } from '@engine/decorations/types';
import { readSpec } from './model';

export interface DecorationPreset {
  readonly id: string;
  readonly name: string;
  readonly kind: DecorationKind;
  readonly spec: DecorationSpec;
  /** False for the ones that ship: those cannot be deleted or overwritten. */
  readonly custom: boolean;
}

const KINDS = new Set<string>(['header-footer', 'bates', 'watermark', 'background']);

/** Reads a list of presets from anything, keeping the ones that make sense. */
export function readPresets(value: unknown, custom: boolean): DecorationPreset[] {
  const list = Array.isArray(value)
    ? value
    : Array.isArray((value as { presets?: unknown } | null)?.presets)
      ? ((value as { presets: unknown[] }).presets)
      : [];
  const out: DecorationPreset[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r['id'] === 'string' ? r['id'] : '';
    const name = typeof r['name'] === 'string' ? r['name'] : '';
    const kind = typeof r['kind'] === 'string' ? r['kind'] : '';
    const spec = readSpec(r['spec']);
    if (id === '' || name === '' || !KINDS.has(kind) || !spec) continue;
    out.push({ id, name, kind: kind as DecorationKind, spec, custom });
  }
  return out;
}

/** The presets that ship with the application, in the order the data file lists them. */
export const BUILT_IN_PRESETS: ReadonlyArray<DecorationPreset> = readPresets(file, false);

/** The built-in presets for one family. */
export function builtInFor(kind: DecorationKind): ReadonlyArray<DecorationPreset> {
  return BUILT_IN_PRESETS.filter((p) => p.kind === kind);
}

/** The reader's own presets, as stored in one settings string. */
export function readCustomPresets(json: string): DecorationPreset[] {
  try {
    return readPresets(JSON.parse(json), true);
  } catch {
    return [];
  }
}

/** Those presets back as a settings string, with one replaced or added. */
export function withPreset(
  presets: ReadonlyArray<DecorationPreset>,
  preset: DecorationPreset,
): DecorationPreset[] {
  const without = presets.filter((p) => p.id !== preset.id);
  return [...without, preset];
}

/** A preset id from a name, unique against what is already there. */
export function presetId(name: string, taken: ReadonlyArray<DecorationPreset>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'preset';
  const ids = new Set(taken.map((p) => p.id));
  if (!ids.has(base)) return base;
  let n = 2;
  while (ids.has(`${base}-${String(n)}`)) n++;
  return `${base}-${String(n)}`;
}

/** Presets as JSON for the settings store — the reader's own only; built-ins are not saved. */
export function presetsToJson(presets: ReadonlyArray<DecorationPreset>): string {
  return JSON.stringify(
    presets
      .filter((p) => p.custom)
      .map((p) => ({ id: p.id, name: p.name, kind: p.kind, spec: p.spec })),
  );
}
