/**
 * Content-stream edits (M50, ADR 0018): transform, remove and insert objects without touching
 * anything else.
 *
 * A **transform** of a page-level object (path, `Do`, `sh`, inline image) wraps its span in
 * `q  M cm  …  Q`, with `M` the page-space delta conjugated into the object's frame
 * (`C⁻¹ · D · C`, see `matrix.ts`), so a nested `cm` or a rotated form moves by what the reader
 * asked for on the paper. A **removal** drops the span.
 *
 * Text is the awkward one, because `q`/`cm` do not belong inside `BT … ET` and because a
 * showing operator advances the text matrix for the operator after it. So a text object is
 * moved by writing an explicit `Tm` before it, and the operators that follow are repaired with
 * the matrices PDFium reported for them: the next `Tj` gets its own `Tm` (its start no longer
 * follows from the previous glyphs), and the next `Td`/`T*` gets the line matrix put back (our
 * `Tm` clobbered it). A removed text object needs only the first repair, since a removal leaves
 * the line matrix alone. Everything needed for this is in the scan and in the plan; nothing is
 * guessed from font metrics.
 *
 * An **insert** appends at the end of the stream, above everything, after closing any `q` the
 * producer left open so the new content starts from the page's own frame.
 */

import type { ObjectStyle, PdfMatrix } from '@shared/pdf';
import { conjugate, invert, isIdentity, multiply } from './matrix';
import {
  isShowTextOperator,
  isTextPositioningOperator,
  scanObjects,
  type ContentObject,
  type ObjectScan,
} from './objects';
import type { ContentOp, ContentStream } from './parser';
import { op } from './serialise';

export type ContentEdit =
  | {
      readonly kind: 'transform';
      readonly index: number;
      /** The delta, in page space, applied after the object's own placement. */
      readonly matrix: PdfMatrix;
    }
  | { readonly kind: 'remove'; readonly index: number }
  | {
      /** A path's stroke and fill properties. Refused for anything that is not a path. */
      readonly kind: 'style';
      readonly index: number;
      readonly style: ObjectStyle;
    }
  | {
      /** Ops appended at the top of the page, already wrapped and positioned by the caller. */
      readonly kind: 'insert';
      readonly ops: ReadonlyArray<ContentOp>;
    };

export interface EditContext {
  /**
   * PDFium's page-space matrix for each **text** object, by index, as reported *before* any
   * edit. Needed to move a text object and to repair the operators after a moved or removed
   * one. A text edit whose matrices are missing is refused rather than guessed.
   */
  readonly textMatrices?: ReadonlyMap<number, PdfMatrix>;
}

export interface EditResult {
  readonly ops: ReadonlyArray<ContentOp>;
  /** Edits that could not be applied, in plain words. */
  readonly refused: ReadonlyArray<string>;
  readonly applied: number;
}

/**
 * The true text-space → page matrix of a text object, from what PDFium reports.
 *
 * PDFium folds the horizontal scaling into the first row and the rise into the origin (see
 * `CPDF_StreamContentParser::AddTextObject`); both have to come out again, or a `Tz 50` block
 * would shrink twice and a superscript would climb.
 */
export function trueTextMatrix(reported: PdfMatrix, tz: number, ts: number): PdfMatrix {
  const scale = tz === 0 ? 1 : tz;
  const lin: PdfMatrix = [reported[0] / scale, reported[1] / scale, reported[2], reported[3], 0, 0];
  return [lin[0], lin[1], lin[2], lin[3], reported[4] - ts * lin[2], reported[5] - ts * lin[3]];
}

/** The `Tm` operands that place a text object whose page matrix is `page` under `ctm`. */
function tmFor(page: PdfMatrix, ctm: PdfMatrix): PdfMatrix | null {
  const inverse = invert(ctm);
  return inverse ? multiply(page, inverse) : null;
}

function tmOp(m: PdfMatrix): ContentOp {
  return op('Tm', m[0], m[1], m[2], m[3], m[4], m[5]);
}

function cmOp(m: PdfMatrix): ContentOp {
  return op('cm', m[0], m[1], m[2], m[3], m[4], m[5]);
}

/** A page-space delta expressed as the matrix to write inside the object's own `q … Q`. */
export function localDelta(delta: PdfMatrix, ctm: PdfMatrix): PdfMatrix {
  return conjugate(delta, ctm);
}

interface Plan {
  readonly before: Map<number, ContentOp[]>;
  readonly after: Map<number, ContentOp[]>;
  readonly skip: Set<number>;
  readonly tail: ContentOp[];
}

export function applyEdits(
  stream: ContentStream,
  edits: ReadonlyArray<ContentEdit>,
  context: EditContext = {},
): EditResult {
  const ops = stream.ops;
  const scan = scanObjects(ops);
  const refused: string[] = [];
  const plan: Plan = { before: new Map(), after: new Map(), skip: new Set(), tail: [] };
  let applied = 0;

  const at = (map: Map<number, ContentOp[]>, k: number): ContentOp[] => {
    let list = map.get(k);
    if (!list) {
      list = [];
      map.set(k, list);
    }
    return list;
  };

  // Compose repeated transforms and styles per object, and let a removal win over both.
  const transforms = new Map<number, PdfMatrix>();
  const styles = new Map<number, ObjectStyle>();
  const removals = new Set<number>();
  for (const e of edits) {
    if (e.kind === 'transform') {
      const current = transforms.get(e.index);
      transforms.set(e.index, current ? multiply(current, e.matrix) : e.matrix);
    } else if (e.kind === 'style') {
      styles.set(e.index, { ...styles.get(e.index), ...e.style });
    } else if (e.kind === 'remove') {
      removals.add(e.index);
    }
  }
  for (const index of removals) {
    transforms.delete(index);
    styles.delete(index);
  }

  const object = (index: number, what: string): ContentObject | null => {
    const o = scan.objects[index];
    if (!o) {
      refused.push(`${what}: no object ${index} (the page has ${scan.objects.length})`);
      return null;
    }
    if (!o.contiguous) {
      refused.push(`${what}: object ${index} is interleaved with graphics-state operators`);
      return null;
    }
    return o;
  };

  const wrapped = new Set<number>([...transforms.keys(), ...styles.keys()]);
  for (const index of wrapped) {
    const delta = transforms.get(index) ?? null;
    const style = styles.get(index) ?? null;
    const o = object(index, delta ? 'transform' : 'style');
    if (!o) continue;
    if (style && o.kind !== 'path') {
      refused.push(`style: object ${index} is not a path`);
      continue;
    }
    const moves = delta !== null && !isIdentity(delta);
    if (o.kind === 'text' && o.text) {
      if (!moves) {
        applied++;
        continue;
      }
      const reported = context.textMatrices?.get(index);
      if (!reported) {
        refused.push(`transform: text object ${index} has no recorded matrix`);
        continue;
      }
      const moved = multiply(trueTextMatrix(reported, o.text.tz, o.text.ts), delta);
      const tm = tmFor(moved, o.ctm);
      if (!tm) {
        refused.push(`transform: text object ${index} sits under a singular matrix`);
        continue;
      }
      at(plan.before, o.opStart).push(tmOp(tm));
      repairAfter(ops, scan, o, { tm: true, tlm: true }, context, plan, refused, removals);
      applied++;
      continue;
    }
    const inner: ContentOp[] = [];
    if (moves) inner.push(cmOp(localDelta(delta, o.ctm)));
    if (style) inner.push(...styleOps(style));
    if (inner.length === 0) {
      applied++;
      continue;
    }
    at(plan.before, o.opStart).unshift(op('q'), ...inner);
    at(plan.after, o.opEnd - 1).push(op('Q'));
    applied++;
  }

  for (const index of removals) {
    const o = object(index, 'remove');
    if (!o) continue;
    for (let k = o.opStart; k < o.opEnd; k++) plan.skip.add(k);
    if (o.kind === 'text' && o.text) {
      repairAfter(ops, scan, o, { tm: true, tlm: false }, context, plan, refused, removals);
    }
    applied++;
  }

  for (const e of edits) {
    if (e.kind !== 'insert') continue;
    if (plan.tail.length === 0) {
      for (let i = 0; i < scan.openDepth; i++) plan.tail.push(op('Q'));
    }
    plan.tail.push(...e.ops);
    applied++;
  }

  const out: ContentOp[] = [];
  ops.forEach((o, k) => {
    const before = plan.before.get(k);
    if (before) out.push(...before);
    if (!plan.skip.has(k)) out.push(o);
    const after = plan.after.get(k);
    if (after) out.push(...after);
  });
  out.push(...plan.tail);
  return { ops: out, refused, applied };
}

/**
 * Repairs the operators that follow a text object whose text matrix (and perhaps line matrix)
 * no longer arrives at the same place. Walks forward inside the `BT` block:
 *
 * - a show operator, while `tm` is dirty, gets its own `Tm` from PDFium's matrix — after which
 *   the text matrix is right again but the line matrix is not;
 * - a line-relative positioning operator (`Td`, `TD`, `T*`, `'`, `"`), while `tlm` is dirty,
 *   gets the original line matrix put back with a `Tm` first;
 * - `Tm` and `ET` end the walk, since nothing after them depends on either.
 *
 * A show operator that is itself being removed is skipped: its own repair happens when it is.
 */
function repairAfter(
  ops: ReadonlyArray<ContentOp>,
  scan: ObjectScan,
  from: ContentObject,
  dirty: { tm: boolean; tlm: boolean },
  context: EditContext,
  plan: Plan,
  refused: string[],
  removals: ReadonlySet<number>,
): void {
  const byOp = new Map<number, ContentObject>();
  for (const o of scan.objects) if (o.kind === 'text') byOp.set(o.opStart, o);
  let tm = dirty.tm;
  let tlm = dirty.tlm;
  for (let k = from.opEnd; k < ops.length && (tm || tlm); k++) {
    const next = ops[k];
    if (!next) break;
    const operator = next.operator;
    if (operator === 'ET' || operator === 'Tm') return;
    if (operator === "'" || operator === '"' || isTextPositioningOperator(operator)) {
      if (tlm) {
        const original = scan.tlmBefore.get(k);
        if (original) plan.before.set(k, [...(plan.before.get(k) ?? []), tmOp(original)]);
      }
      return;
    }
    if (isShowTextOperator(operator)) {
      const o = byOp.get(k);
      if (!o?.text) continue;
      if (removals.has(o.index)) continue;
      if (tm) {
        const reported = context.textMatrices?.get(o.index);
        if (!reported) {
          refused.push(`repair: text object ${o.index} after ${from.index} has no recorded matrix`);
          return;
        }
        const m = tmFor(trueTextMatrix(reported, o.text.tz, o.text.ts), o.ctm);
        if (!m) return;
        const list = plan.before.get(k) ?? [];
        // A transform of this same object already placed a Tm; do not add a second.
        if (!list.some((x) => x.operator === 'Tm')) plan.before.set(k, [...list, tmOp(m)]);
        tm = false;
        tlm = true;
      }
    }
  }
}

/** The graphics-state ops a style change needs, for the inside of the object's `q … Q`. */
export function styleOps(style: ObjectStyle): ContentOp[] {
  const out: ContentOp[] = [];
  const rgb = (c: number): [number, number, number] => [
    ((c >> 16) & 255) / 255,
    ((c >> 8) & 255) / 255,
    (c & 255) / 255,
  ];
  if (style.fillColor !== undefined) out.push(op('rg', ...rgb(style.fillColor)));
  if (style.strokeColor !== undefined) out.push(op('RG', ...rgb(style.strokeColor)));
  if (style.strokeWidth !== undefined) out.push(op('w', Math.max(0, style.strokeWidth)));
  if (style.dash !== undefined) {
    out.push(
      op('d', { kind: 'array', items: style.dash.map((v) => ({ kind: 'number', value: v })) }, 0),
    );
  }
  return out;
}

/** The ops that draw an XObject named `name` under `matrix`, self-contained in `q … Q`. */
export function drawXObjectOps(name: string, matrix: PdfMatrix): ContentOp[] {
  return [op('q'), cmOp(matrix), op('Do', name), op('Q')];
}
