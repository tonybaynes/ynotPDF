/**
 * The one place that knows which model key is which PDF dictionary key (M30, ADR 0013; extended
 * by M31, ADR 0015).
 *
 * `Annotation.extra` is a free-form bag by design — the engine adapter puts into it whatever a
 * subtype happens to carry, and a module reads back what it understands. That freedom stops
 * being helpful the moment the same bag has to be *written*: three separate files would each be
 * making their own guess about whether `align` means `/Q`, and one of them would be wrong.
 *
 * So the mapping is data here, and three consumers read it:
 *
 * - `pdfium/mutations.ts` writes the string-valued entries straight onto the live annotation, so
 *   the engine's own bytes carry them;
 * - M21's `buildWritePlan` turns the rest — numbers and arrays, which PDFium's annotation API has
 *   no setter for — into `PlannedAnnotationProperties.entries`;
 * - the appearance generators read the model values by their model names.
 *
 * Nothing here touches a PDF library or PDFium: it is a table plus two pure functions.
 */

/** A value a planned dictionary entry may take. `null` removes the entry. */
export type DictValue =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'name'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'numbers'; readonly value: ReadonlyArray<number> }
  /** An array of names — a Line's `/LE [/None /OpenArrow]` (M31). */
  | { readonly kind: 'names'; readonly value: ReadonlyArray<string> }
  /**
   * A dictionary — `/BE << /S /C /I 1 >>`, or the `/BS` entries a dash needs (M31). The writer
   * *merges* it into a dictionary the annotation already has, so `/BS /W`, which the border
   * width wrote, survives a `/BS /D` written beside it.
   */
  | { readonly kind: 'dict'; readonly value: Readonly<Record<string, DictValue | null>> }
  /**
   * A reference to an embedded file, by its name in the `/EmbeddedFiles` name tree (M31). The
   * writer resolves it to the file specification, sets the entry to that object, and removes the
   * name-tree entry so the file is listed once — on the annotation.
   */
  | { readonly kind: 'embeddedFile'; readonly value: string };

/** How one model key reaches the file. */
export interface DictMapping {
  /** Key inside `Annotation.extra`. */
  readonly key: string;
  /** PDF dictionary key, without the leading slash. */
  readonly pdfKey: string;
  readonly kind: DictValue['kind'];
  /**
   * True when `FPDFAnnot_SetStringValue` can write it, so the engine carries it and the plan does
   * not have to. Only text and name values qualify; PDFium has no generic number or array setter.
   */
  readonly engineWritable: boolean;
  /**
   * Turns the model's value into the typed entry, for the kinds whose model shape is not the
   * PDF shape — a dash is `[3, 2]` in the model and `<< /S /D /D [3 2] >>` in the file. Absent
   * means the value is coerced by `kind` alone.
   */
  readonly encode?: (value: unknown) => DictValue | null;
  /**
   * A value that means "this entry is absent" — a cloud intensity of 0 — so it removes the
   * entry rather than being skipped as malformed.
   */
  readonly empty?: (value: unknown) => boolean;
}

/** A finite-number array, or null. */
function finiteNumbers(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const numbers = value.filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
  return numbers.length === value.length ? numbers : null;
}

/**
 * Every `extra` key this app writes. Deliberately a closed list: an unknown key in the bag is
 * something another module put there for its own use and must not reach the file as a guess.
 */
export const ANNOTATION_DICT_MAPPINGS: ReadonlyArray<DictMapping> = [
  // Sticky-note / stamp / attachment icon.
  { key: 'icon', pdfKey: 'Name', kind: 'name', engineWritable: true },
  // Free text: the default appearance string, the rich-text style, and the rich text itself.
  { key: 'defaultAppearance', pdfKey: 'DA', kind: 'string', engineWritable: true },
  { key: 'defaultStyle', pdfKey: 'DS', kind: 'string', engineWritable: true },
  { key: 'richContents', pdfKey: 'RC', kind: 'string', engineWritable: true },
  // `/IT` distinguishes a typewriter from a text box from a callout — and, for M31, an arrow
  // from a line, a cloud from a polygon, and an area highlight from a text highlight.
  { key: 'intent', pdfKey: 'IT', kind: 'name', engineWritable: true },
  // The review-state model a `/State` belongs to ("Review" or "Marked"); M32 uses it.
  { key: 'stateModel', pdfKey: 'StateModel', kind: 'string', engineWritable: true },
  // The callout's leader line: 6 numbers (tip, knee, shoulder) or 4 (tip, shoulder).
  { key: 'callout', pdfKey: 'CL', kind: 'numbers', engineWritable: false },
  // Quadding: 0 left, 1 centre, 2 right.
  { key: 'align', pdfKey: 'Q', kind: 'number', engineWritable: false },
  // Rotation of the text inside the box, anticlockwise degrees, a multiple of 90 — and, for a
  // stamp, the turn of the whole picture, any angle.
  { key: 'rotate', pdfKey: 'Rotate', kind: 'number', engineWritable: false },
  // `/RD` — the inset from `/Rect` to the text box, four numbers (left, top, right, bottom).
  { key: 'padding', pdfKey: 'RD', kind: 'numbers', engineWritable: false },
  // Line ending of a callout's leader line, e.g. `OpenArrow`.
  { key: 'lineEnding', pdfKey: 'LE', kind: 'name', engineWritable: true },
  /*
   * M31 (ADR 0015). A Line's or PolyLine's two endings, `[start, end]`; a cloudy border with
   * its intensity; a dash pattern; and the embedded file a FileAttachment annotation shows.
   *
   * `lineEndings` and `lineEnding` both reach `/LE`: a callout's is one name, a line's is two.
   * An annotation carries one or the other, never both, and `dictEntries` keeps the last one
   * written — which is the array for a line, because it is listed after.
   */
  {
    key: 'lineEndings',
    pdfKey: 'LE',
    kind: 'names',
    engineWritable: false,
    encode: (value) => {
      const names = Array.isArray(value)
        ? value.filter((v): v is string => typeof v === 'string')
        : [];
      return Array.isArray(value) && names.length === 2 && names.length === value.length
        ? { kind: 'names', value: names }
        : null;
    },
  },
  {
    key: 'cloudy',
    pdfKey: 'BE',
    kind: 'dict',
    engineWritable: false,
    // The model holds the intensity (0..2); `0` means "not cloudy", which removes `/BE`.
    empty: (value) => typeof value === 'number' && value <= 0,
    encode: (value) => {
      const intensity = typeof value === 'number' && Number.isFinite(value) ? value : 0;
      if (intensity <= 0) return null;
      return {
        kind: 'dict',
        value: { S: { kind: 'name', value: 'C' }, I: { kind: 'number', value: intensity } },
      };
    },
  },
  {
    key: 'dashArray',
    pdfKey: 'BS',
    kind: 'dict',
    engineWritable: false,
    encode: (value) => {
      const numbers = finiteNumbers(value)?.filter((n) => n > 0) ?? [];
      // No dashes is a solid border: `/S /S`, and any `/D` the file had goes.
      if (numbers.length === 0) {
        return { kind: 'dict', value: { S: { kind: 'name', value: 'S' }, D: null } };
      }
      return {
        kind: 'dict',
        value: { S: { kind: 'name', value: 'D' }, D: { kind: 'numbers', value: numbers } },
      };
    },
  },
  { key: 'attachmentName', pdfKey: 'FS', kind: 'embeddedFile', engineWritable: false },
];

const BY_KEY = new Map(ANNOTATION_DICT_MAPPINGS.map((m) => [m.key, m]));

/** The mapping for a model key, or `undefined` when it is not one we write. */
export function dictMapping(key: string): DictMapping | undefined {
  return BY_KEY.get(key);
}

/** Model keys the engine can write itself, as `[extraKey, pdfKey]` pairs. */
export function engineWritableKeys(): ReadonlyArray<readonly [string, string]> {
  return ANNOTATION_DICT_MAPPINGS.filter((m) => m.engineWritable).map(
    (m) => [m.key, m.pdfKey] as const,
  );
}

/** Coerces one `extra` value into the typed form the writer wants, or `null` if it cannot. */
export function toDictValue(mapping: DictMapping, value: unknown): DictValue | null {
  if (mapping.encode) return mapping.encode(value);
  switch (mapping.kind) {
    case 'string':
    case 'name':
    case 'embeddedFile':
      return typeof value === 'string' && value !== ''
        ? { kind: mapping.kind, value }
        : /* an empty string is a removal, not a value */ null;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? { kind: 'number', value } : null;
    case 'numbers': {
      const numbers = finiteNumbers(value);
      return numbers && numbers.length > 0 ? { kind: 'numbers', value: numbers } : null;
    }
    case 'names': {
      const names = Array.isArray(value)
        ? value.filter((v): v is string => typeof v === 'string')
        : null;
      return names && Array.isArray(value) && names.length === value.length
        ? { kind: 'names', value: names }
        : null;
    }
    case 'dict':
      return null;
  }
}

/**
 * The dictionary entries an annotation's `extra` bag asks for, keyed by PDF key.
 *
 * `null` means "remove this entry", which is what a value going away has to say: an entry left in
 * the file would otherwise outlive the property the reader cleared. Only keys the mapping knows
 * are considered, and only those the caller asks about — `engineWrote` names the ones PDFium has
 * already put in the bytes, so the plan does not write them a second time.
 *
 * A key whose value means "off" — a cloud with intensity 0, an empty dash — is a removal too: the
 * reader turned the thing off, and the file must not keep saying it is on.
 */
export function dictEntries(
  extra: Readonly<Record<string, unknown>>,
  options: { readonly skipEngineWritable?: boolean } = {},
): Record<string, DictValue | null> {
  const out: Record<string, DictValue | null> = {};
  for (const mapping of ANNOTATION_DICT_MAPPINGS) {
    if (options.skipEngineWritable && mapping.engineWritable) continue;
    if (!(mapping.key in extra)) continue;
    const raw = extra[mapping.key];
    if (raw === null || raw === undefined || raw === '' || mapping.empty?.(raw) === true) {
      // `/BS` also carries the border width; a dash going away is a solid border, not no border.
      out[mapping.pdfKey] = mapping.pdfKey === 'BS' ? toDictValue(mapping, []) : null;
      continue;
    }
    // A value that cannot be encoded is malformed, not absent: it is skipped rather than
    // half-written or removed, which is what M30 promised for a `/CL` with a word in it.
    const value = toDictValue(mapping, raw);
    if (value) out[mapping.pdfKey] = value;
  }
  return out;
}
