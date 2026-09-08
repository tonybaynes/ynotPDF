/**
 * Permissions in three representations, and the conversions between them (M70).
 *
 * - {@link PermissionFlags} — the app's vocabulary, what the dialog shows and the model stores.
 * - The `/P` bitfield — what a PDF file stores (ISO 32000-1 table 22).
 * - qpdf's command line — what actually writes the file.
 *
 * All of it is pure and none of it knows about a document. The round-trip
 * `pToPermissions(permissionsToP(x)) === x` holds for every value the dialog can produce, and the
 * qpdf mapping is checked against qpdf's own `--show-encryption` output in the tests, so a flag
 * cannot mean one thing to us and another to the file.
 *
 * The bit numbering is the spec's, which is 1-based and starts its meaningful bits at 3. Bits 1,
 * 2, 7 and 8 are reserved and must be 0; every other reserved bit must be 1. `/P` is written as a
 * signed 32-bit integer, which is why it is nearly always negative.
 */

import type { Permissions as EnginePermissions } from '../PdfEngine';
import {
  ALL_ALLOWED,
  type EncryptionAlgorithm,
  type EncryptionScope,
  type ModifyPermission,
  type PermissionFlags,
  type PrintPermission,
  type ProtectedAction,
} from './types';

/** Spec bit numbers (1-based), named. */
const BIT = {
  /** Print the document. */
  print: 3,
  /** Modify the contents by operations other than those controlled by 6, 9 and 11. */
  modify: 4,
  /** Copy or otherwise extract text and graphics. */
  copy: 5,
  /** Add or modify annotations, and fill in form fields. */
  annotate: 6,
  /** Fill in form fields, even when bit 6 is clear. */
  fillForms: 9,
  /** Extract text and graphics for accessibility. */
  accessibility: 10,
  /** Assemble the document — insert, rotate, delete pages, add bookmarks. */
  assemble: 11,
  /** Print at high resolution. When clear, printing is degraded. */
  printHigh: 12,
} as const;

/** All reserved-and-must-be-1 bits, as a mask: everything except 1, 2 and the meaningful ones. */
const RESERVED_HIGH = (() => {
  let mask = 0;
  const meaningful = new Set<number>(Object.values(BIT));
  for (let bit = 1; bit <= 32; bit++) {
    if (bit === 1 || bit === 2 || bit === 7 || bit === 8) continue;
    if (meaningful.has(bit)) continue;
    mask |= 1 << (bit - 1);
  }
  return mask;
})();

function set(value: number, bit: number, on: boolean): number {
  return on ? value | (1 << (bit - 1)) : value & ~(1 << (bit - 1));
}

function has(value: number, bit: number): boolean {
  return (value & (1 << (bit - 1))) !== 0;
}

/** Whether a modify level allows annotating. */
function allowsAnnotate(modify: ModifyPermission): boolean {
  return modify === 'all' || modify === 'comment-fill-and-sign';
}

/** Whether a modify level allows filling form fields and signing. */
function allowsFillForms(modify: ModifyPermission): boolean {
  return modify !== 'none' && modify !== 'assemble';
}

/** Whether a modify level allows page assembly. */
function allowsAssemble(modify: ModifyPermission): boolean {
  return modify === 'all' || modify === 'assemble';
}

/** Turns our flags into the `/P` integer a PDF stores. */
export function permissionsToP(flags: PermissionFlags): number {
  let p = RESERVED_HIGH;
  p = set(p, BIT.print, flags.print !== 'none');
  p = set(p, BIT.printHigh, flags.print === 'high');
  p = set(p, BIT.modify, flags.modify === 'all');
  p = set(p, BIT.annotate, allowsAnnotate(flags.modify));
  p = set(p, BIT.fillForms, allowsFillForms(flags.modify));
  p = set(p, BIT.assemble, allowsAssemble(flags.modify));
  p = set(p, BIT.copy, flags.copy);
  p = set(p, BIT.accessibility, flags.accessibility);
  // `/P` is a signed 32-bit integer, and bit 32 is one of the reserved-high ones.
  return p | 0;
}

/**
 * Reads a `/P` integer back into our flags.
 *
 * The modify level is the *most* a reader may do, chosen by walking down from `all`, because a
 * file written by another application may set a combination our five choices do not name — and
 * reporting the nearest thing below it is safer than reporting the nearest thing above.
 */
export function pToPermissions(p: number): PermissionFlags {
  const print: PrintPermission = !has(p, BIT.print)
    ? 'none'
    : has(p, BIT.printHigh)
      ? 'high'
      : 'low';
  const modify: ModifyPermission = has(p, BIT.modify)
    ? 'all'
    : has(p, BIT.annotate)
      ? 'comment-fill-and-sign'
      : has(p, BIT.fillForms)
        ? 'fill-and-sign'
        : has(p, BIT.assemble)
          ? 'assemble'
          : 'none';
  return {
    print,
    modify,
    copy: has(p, BIT.copy),
    accessibility: has(p, BIT.accessibility),
  };
}

/**
 * The engine's `Permissions` — what PDFium reports for an open document — in our vocabulary.
 *
 * PDFium has one boolean per spec bit; we have four values that name the combinations a reader
 * chooses between. The collapsing is the same as {@link pToPermissions}'s and for the same reason:
 * a file may set a combination our four choices do not name, and reporting the nearest thing
 * *below* it is the safe direction to round.
 */
export function fromEnginePermissions(p: EnginePermissions): PermissionFlags {
  return {
    print: !p.print ? 'none' : p.printHighQuality ? 'high' : 'low',
    modify: p.modify
      ? 'all'
      : p.annotate
        ? 'comment-fill-and-sign'
        : p.fillForms
          ? 'fill-and-sign'
          : p.assemble
            ? 'assemble'
            : 'none',
    copy: p.copy,
    accessibility: p.extractForAccessibility,
  };
}

/** Whether the flags allow one specific thing the reader is trying to do. */
export function permits(flags: PermissionFlags, action: ProtectedAction): boolean {
  switch (action) {
    case 'print':
      return flags.print !== 'none';
    case 'print-high':
      return flags.print === 'high';
    case 'copy':
      return flags.copy;
    case 'extract-for-accessibility':
      return flags.accessibility || flags.copy;
    case 'modify':
      return flags.modify === 'all';
    case 'annotate':
      return allowsAnnotate(flags.modify);
    case 'fill-forms':
      return allowsFillForms(flags.modify);
    case 'assemble':
      return allowsAssemble(flags.modify);
    default:
      return true;
  }
}

/**
 * Why an action is not allowed, as a sentence to put in a tooltip.
 *
 * Always names the permission and always says what would lift it, because a control that is
 * disabled without saying why is the thing this app is trying not to be.
 */
export function reasonFor(action: ProtectedAction): string {
  const what: Record<ProtectedAction, string> = {
    print: 'printing',
    'print-high': 'printing at full resolution',
    copy: 'copying text and images',
    'extract-for-accessibility': 'extracting text for accessibility',
    modify: 'changing the document',
    annotate: 'adding or changing comments',
    'fill-forms': 'filling in form fields',
    assemble: 'inserting, deleting or moving pages',
  };
  return `The document's security settings do not allow ${what[action]}. Enter the owner password to unlock it.`;
}

/** Every action a permission set forbids. Used by the status item and the Properties tab. */
export function forbidden(flags: PermissionFlags): ProtectedAction[] {
  const all: ProtectedAction[] = [
    'print',
    'print-high',
    'copy',
    'extract-for-accessibility',
    'modify',
    'annotate',
    'fill-forms',
    'assemble',
  ];
  return all.filter((a) => !permits(flags, a));
}

/** One line describing what a permission set allows, for the Properties tab and the status item. */
export function describePermissions(flags: PermissionFlags): string {
  const parts: string[] = [];
  parts.push(
    flags.print === 'high'
      ? 'Printing allowed'
      : flags.print === 'low'
        ? 'Low-resolution printing only'
        : 'No printing',
  );
  parts.push(
    flags.modify === 'all'
      ? 'all changes allowed'
      : flags.modify === 'comment-fill-and-sign'
        ? 'commenting and form filling only'
        : flags.modify === 'fill-and-sign'
          ? 'form filling and signing only'
          : flags.modify === 'assemble'
            ? 'page assembly only'
            : 'no changes',
  );
  parts.push(flags.copy ? 'copying allowed' : 'no copying');
  return `${parts.join(', ')}.`;
}

// ---- qpdf ---------------------------------------------------------------------------------------

/**
 * The `--encrypt … --` argument list for one set of options.
 *
 * The passwords are passed as separate `--user-password=` / `--owner-password=` arguments (the
 * flag form qpdf added in 11.7), which is what lets a password contain a space, a leading dash or
 * a non-ASCII character without any quoting of our own. They never reach a shell: qpdf runs as
 * WebAssembly and `callMain` takes the argv array directly.
 */
export function encryptArgs(options: {
  readonly algorithm: EncryptionAlgorithm;
  readonly permissions: PermissionFlags;
  readonly scope: EncryptionScope;
  readonly userPassword: string;
  readonly ownerPassword: string;
}): string[] {
  const bits = algorithmBits(options.algorithm);
  const args = ['--encrypt'];
  args.push(`--user-password=${options.userPassword}`);
  args.push(`--owner-password=${options.ownerPassword}`);
  args.push(`--bits=${String(bits)}`);

  const p = options.permissions;
  if (bits === 40) {
    // 40-bit has only the four original bits, and qpdf names them differently.
    args.push(`--print=${p.print === 'none' ? 'n' : 'y'}`);
    args.push(`--modify=${p.modify === 'all' ? 'y' : 'n'}`);
    args.push(`--extract=${p.copy ? 'y' : 'n'}`);
    args.push(`--annotate=${allowsAnnotate(p.modify) ? 'y' : 'n'}`);
  } else {
    args.push(`--print=${qpdfPrint(p.print)}`);
    args.push(`--modify=${qpdfModify(p.modify)}`);
    args.push(`--extract=${p.copy ? 'y' : 'n'}`);
    args.push(`--annotate=${allowsAnnotate(p.modify) ? 'y' : 'n'}`);
    args.push(`--form=${allowsFillForms(p.modify) ? 'y' : 'n'}`);
    args.push(`--assemble=${allowsAssemble(p.modify) ? 'y' : 'n'}`);
    args.push(`--modify-other=${p.modify === 'all' ? 'y' : 'n'}`);
    args.push(`--accessibility=${p.accessibility ? 'y' : 'n'}`);
    if (options.scope === 'except-metadata') args.push('--cleartext-metadata');
  }
  if (options.algorithm === 'aes-128') args.push('--use-aes=y');
  if (options.algorithm === 'rc4-128') args.push('--use-aes=n');
  // qpdf refuses a user password with an empty owner password unless told the risk is intended;
  // that combination is exactly "anyone who can open it can change it", which is a legitimate
  // choice and the dialog says so in words.
  if (bits === 256 && options.userPassword !== '' && options.ownerPassword === '') {
    args.push('--allow-insecure');
  }
  args.push('--');
  return args;
}

/**
 * qpdf's `--print=` levels. Ours calls full-resolution printing "high", after the spec's bit 12
 * ("print high resolution"); qpdf calls it `full`. The names differ, the meaning does not.
 */
function qpdfPrint(print: PrintPermission): string {
  return print === 'high' ? 'full' : print;
}

/** qpdf's `--modify=` levels, which are a superset of ours. */
function qpdfModify(modify: ModifyPermission): string {
  switch (modify) {
    case 'all':
      return 'all';
    case 'comment-fill-and-sign':
      return 'annotate';
    case 'fill-and-sign':
      return 'form';
    case 'assemble':
      return 'assembly';
    case 'none':
      return 'none';
    default:
      return 'none';
  }
}

/** Whether qpdf needs `--allow-weak-crypto` to write this algorithm. */
export function needsWeakCryptoFlag(algorithm: EncryptionAlgorithm): boolean {
  return algorithm === 'rc4-40' || algorithm === 'rc4-128';
}

function algorithmBits(algorithm: EncryptionAlgorithm): 40 | 128 | 256 {
  switch (algorithm) {
    case 'aes-256':
      return 256;
    case 'rc4-40':
      return 40;
    default:
      return 128;
  }
}

/** The unencrypted answer, so callers can avoid a special case. */
export const UNRESTRICTED = ALL_ALLOWED;
