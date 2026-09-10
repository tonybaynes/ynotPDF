/**
 * Content-object scanner (M50, ADR 0018): which operators make up each object PDFium counts.
 *
 * PDFium's `FPDFPage_CountObjects` enumerates one object per painted path, per text-showing
 * operator, per `Do`, per `sh` and per inline image, in content-stream order. This scan produces
 * the same list from the ops alone, with what an edit needs to know about each one: the span of
 * operators that *are* the object (never the state operators around it), the CTM in force when
 * it starts, and — for text — the line matrix, horizontal scaling and rise, which is what a
 * repositioned `Tj` has to leave intact for the operators after it.
 *
 * The rules that decide whether an operator makes an object mirror PDFium's parser, including
 * its two quiet exceptions: a path with one point paints nothing, and a `Tj` with no font set
 * (no `Tf` anywhere before it) is dropped. A `Do` cannot be told apart as image or form without
 * the resources, so it is reported as `xobject`; `objectKindsAgree` accepts either.
 */

import type { PdfMatrix } from '@shared/pdf';
import { IDENTITY, multiply, translation } from './matrix';
import { nameOperand, numbers, type ContentOp } from './parser';

export type ContentObjectKind = 'text' | 'path' | 'image' | 'xobject' | 'shading';

/** What a text object needs beyond its span, all in the stream's own coordinate frame. */
export interface TextContext {
  /** Op index of the `BT` that opened the block. */
  readonly bt: number;
  /** The line matrix (`Tlm`) in force just before the showing operator. */
  readonly tlm: PdfMatrix;
  /** `Tz` as a factor (1 = 100 %). */
  readonly tz: number;
  /** `Ts` — rise. */
  readonly ts: number;
}

export interface ContentObject {
  readonly index: number;
  readonly kind: ContentObjectKind;
  /** Op indexes of the object's own operators, `[opStart, opEnd)`. */
  readonly opStart: number;
  readonly opEnd: number;
  /**
   * Whether every op in the span belongs to the object. A path whose construction is interleaved
   * with state operators (`10 10 m 2 w 20 20 l S`) is not, and wrapping it would change what
   * those operators do afterwards — so an edit refuses it.
   */
  readonly contiguous: boolean;
  /** The CTM in force at `opStart`. */
  readonly ctm: PdfMatrix;
  /** `q` nesting depth at `opStart`. */
  readonly depth: number;
  /** The resource name a `Do` refers to. */
  readonly name?: string;
  readonly text?: TextContext;
}

export interface ObjectScan {
  readonly objects: ReadonlyArray<ContentObject>;
  /** The CTM in force before each op. */
  readonly ctmBefore: ReadonlyArray<PdfMatrix>;
  /** The line matrix before each op that sits inside a `BT … ET` block. */
  readonly tlmBefore: ReadonlyMap<number, PdfMatrix>;
  /** `q`s still open at the end of the stream. */
  readonly openDepth: number;
  /** The CTM in force after the last op. */
  readonly ctmAtEnd: PdfMatrix;
}

interface GState {
  ctm: PdfMatrix;
  fontSet: boolean;
  tz: number;
  ts: number;
  tl: number;
}

const CONSTRUCTION = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're']);
const PAINT = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n']);
const SHOW = new Set(['Tj', 'TJ', "'", '"']);

export function isShowTextOperator(operator: string): boolean {
  return SHOW.has(operator);
}

/** Operators that reset the text matrix from the line matrix (or set both). */
export function isTextPositioningOperator(operator: string): boolean {
  return operator === 'Td' || operator === 'TD' || operator === 'T*' || operator === 'Tm';
}

/** Whether a show operator would show anything (PDFium drops empty ones). */
function showsSomething(op: ContentOp): boolean {
  for (const v of op.operands) {
    if (v.kind === 'string' && v.value.length > 0) return true;
    if (v.kind === 'array') {
      for (const item of v.items) if (item.kind === 'string' && item.value.length > 0) return true;
    }
  }
  return false;
}

export function scanObjects(ops: ReadonlyArray<ContentOp>): ObjectScan {
  const objects: ContentObject[] = [];
  const ctmBefore: PdfMatrix[] = [];
  const tlmBefore = new Map<number, PdfMatrix>();
  const stack: GState[] = [];
  let gs: GState = { ctm: IDENTITY, fontSet: false, tz: 1, ts: 0, tl: 0 };
  let tlm: PdfMatrix = IDENTITY;
  let inText = false;
  let bt = -1;

  // The path under construction: which ops it is made of, and how many points it has.
  let pathOps: number[] = [];
  let points = 0;
  let start: { x: number; y: number } | null = null;
  let current: { x: number; y: number } | null = null;

  const resetPath = (): void => {
    pathOps = [];
    points = 0;
    start = null;
    current = null;
  };

  const add = (object: Omit<ContentObject, 'index'>): void => {
    objects.push({ index: objects.length, ...object });
  };

  ops.forEach((op, k) => {
    ctmBefore.push(gs.ctm);
    if (inText) tlmBefore.set(k, tlm);
    const n = numbers(op);
    const operator = op.operator;

    if (CONSTRUCTION.has(operator)) {
      pathOps.push(k);
      switch (operator) {
        case 'm':
          points += 1;
          start = { x: n[0] ?? 0, y: n[1] ?? 0 };
          current = start;
          break;
        case 'l':
          points += 1;
          current = { x: n[0] ?? 0, y: n[1] ?? 0 };
          break;
        case 'c':
          points += 3;
          current = { x: n[4] ?? 0, y: n[5] ?? 0 };
          break;
        case 'v':
        case 'y':
          points += 2;
          current = { x: n[2] ?? 0, y: n[3] ?? 0 };
          break;
        case 're':
          points += 5;
          start = { x: n[0] ?? 0, y: n[1] ?? 0 };
          current = start;
          break;
        case 'h':
          if (points > 0 && start && current && (start.x !== current.x || start.y !== current.y)) {
            points += 1;
            current = start;
          }
          break;
      }
      return;
    }

    if (PAINT.has(operator)) {
      if (pathOps.length > 0) {
        const first = pathOps[0] ?? k;
        const contiguous =
          pathOps.every((index, i) => index === first + i) && pathOps[pathOps.length - 1] === k - 1;
        if (operator !== 'n' && points > 1) {
          add({
            kind: 'path',
            opStart: first,
            opEnd: k + 1,
            contiguous,
            ctm: ctmBefore[first] ?? gs.ctm,
            depth: stack.length,
          });
        }
      }
      resetPath();
      return;
    }

    switch (operator) {
      case 'q':
        stack.push({ ...gs });
        return;
      case 'Q':
        if (stack.length > 0) gs = stack.pop() ?? gs;
        return;
      case 'cm':
        gs.ctm = multiply(
          [n[0] ?? 1, n[1] ?? 0, n[2] ?? 0, n[3] ?? 1, n[4] ?? 0, n[5] ?? 0],
          gs.ctm,
        );
        return;
      case 'Tf':
        gs.fontSet = true;
        return;
      case 'Tz':
        gs.tz = (n[0] ?? 100) / 100;
        return;
      case 'Ts':
        gs.ts = n[0] ?? 0;
        return;
      case 'TL':
        gs.tl = n[0] ?? 0;
        return;
      case 'BT':
        inText = true;
        bt = k;
        tlm = IDENTITY;
        return;
      case 'ET':
        inText = false;
        bt = -1;
        return;
      case 'Tm':
        tlm = [n[0] ?? 1, n[1] ?? 0, n[2] ?? 0, n[3] ?? 1, n[4] ?? 0, n[5] ?? 0];
        return;
      case 'Td':
        tlm = multiply(translation(n[0] ?? 0, n[1] ?? 0), tlm);
        return;
      case 'TD':
        gs.tl = -(n[1] ?? 0);
        tlm = multiply(translation(n[0] ?? 0, n[1] ?? 0), tlm);
        return;
      case 'T*':
        tlm = multiply(translation(0, -gs.tl), tlm);
        return;
      case "'":
      case '"':
        tlm = multiply(translation(0, -gs.tl), tlm);
        if (gs.fontSet && showsSomething(op)) {
          add({
            kind: 'text',
            opStart: k,
            opEnd: k + 1,
            contiguous: true,
            ctm: gs.ctm,
            depth: stack.length,
            text: { bt, tlm, tz: gs.tz, ts: gs.ts },
          });
        }
        return;
      case 'Tj':
      case 'TJ':
        if (gs.fontSet && showsSomething(op)) {
          add({
            kind: 'text',
            opStart: k,
            opEnd: k + 1,
            contiguous: true,
            ctm: gs.ctm,
            depth: stack.length,
            text: { bt, tlm, tz: gs.tz, ts: gs.ts },
          });
        }
        return;
      case 'Do': {
        const name = nameOperand(op);
        add({
          kind: 'xobject',
          opStart: k,
          opEnd: k + 1,
          contiguous: true,
          ctm: gs.ctm,
          depth: stack.length,
          ...(name !== null ? { name } : {}),
        });
        return;
      }
      case 'sh':
        add({
          kind: 'shading',
          opStart: k,
          opEnd: k + 1,
          contiguous: true,
          ctm: gs.ctm,
          depth: stack.length,
        });
        return;
      case 'BI':
        add({
          kind: 'image',
          opStart: k,
          opEnd: k + 1,
          contiguous: true,
          ctm: gs.ctm,
          depth: stack.length,
        });
        return;
      default:
        return;
    }
  });

  return { objects, ctmBefore, tlmBefore, openDepth: stack.length, ctmAtEnd: gs.ctm };
}

/** PDFium's kind names as `pageObjects()` reports them. */
export type EngineObjectKind = 'text' | 'path' | 'image' | 'shading' | 'form';

/**
 * Whether the scan agrees with what PDFium enumerated, object for object. A `Do` matches an
 * `image` or a `form`; an inline image matches `image`. Anything else is a mismatch, and a
 * mismatch means an index cannot be trusted to name the same object in both worlds.
 */
export function objectKindsAgree(
  scanned: ReadonlyArray<ContentObject>,
  engine: ReadonlyArray<string>,
): boolean {
  if (scanned.length !== engine.length) return false;
  return scanned.every((o, i) => {
    const e = engine[i];
    if (o.kind === 'xobject') return e === 'image' || e === 'form';
    return o.kind === e;
  });
}
