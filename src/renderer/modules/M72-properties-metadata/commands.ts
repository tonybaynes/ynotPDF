/**
 * M72's document commands: change the properties, change the initial view (ADR 0017).
 *
 * Both are model-only plus a write intent, because PDFium has a setter for none of what they
 * touch — the information dictionary, the XMP packet, `/PageMode`, `/PageLayout`, `/OpenAction`,
 * `/ViewerPreferences`, `/Lang` and the base URL all reach the file through M21's writer.
 *
 * `SetPropertiesCommand` deliberately does not reuse M20's `SetMetadataCommand`. That one takes a
 * flat `Record<string, string | null>`, which cannot express a custom-property map or a `null`
 * that means "remove this key" inside one — and, more importantly, it does not keep XMP in step.
 * Here the two are one edit: the patch is applied to the model and the packet is re-derived from
 * the result, so the file can never be saved with an Info dictionary and an XMP packet that
 * disagree.
 */

import type { Command, CommandJson } from '@core/Command';
import type { Document, DocumentCommand } from '@core/Document';
import type { ModelMetadata, ViewSettings, WriteIntent } from '@core/model';
import { registerCommandCodec } from '@core/Journal';
import { patchXmp, type XmpFacts } from '@engine/xmp';

export const M72_COMMAND_ID = {
  setProperties: 'properties.set',
  setInitialView: 'properties.setInitialView',
} as const;

/** The metadata fields a properties patch may carry. */
type MetadataPatch = Partial<ModelMetadata>;

/**
 * Applies a metadata patch and rewrites the XMP packet to agree with it.
 *
 * The packet is patched rather than regenerated (see `src/engine/xmp/`), so a PDF/A block, an
 * `xmpMM` history or anything else the file carries comes through untouched.
 */
export class SetPropertiesCommand implements DocumentCommand {
  readonly id = M72_COMMAND_ID.setProperties;
  readonly label = 'Change document properties';
  readonly writeIntents: ReadonlyArray<WriteIntent>;
  readonly mergeable = true;
  private readonly doc: Document;
  private readonly patch: MetadataPatch;
  private before: MetadataPatch | null = null;

  constructor(doc: Document, patch: MetadataPatch) {
    this.doc = doc;
    this.patch = patch;
    // `/Lang` and the base URL sit in the catalogue rather than in the information dictionary,
    // and the plan carries them in its view section — so a patch that touches either needs that
    // section planned as well, or the change would live in the model and never reach the file.
    this.writeIntents = 'lang' in patch || 'baseUrl' in patch ? ['metadata', 'view'] : ['metadata'];
  }

  do(): void {
    // The whole of what the patch touches, including the packet, so undo is one step back.
    this.before ??= currentValues(this.doc, this.patch);
    apply(this.doc, this.patch);
  }

  undo(): void {
    if (this.before) apply(this.doc, this.before, { xmp: false });
  }

  merge(next: Command): Command | null {
    if (!(next instanceof SetPropertiesCommand)) return null;
    const merged = new SetPropertiesCommand(this.doc, { ...this.patch, ...next.patch });
    // The earlier "before" wins, so one undo returns to the state before the whole run of edits.
    merged.before = { ...next.before, ...this.before };
    return merged;
  }

  toJSON(): CommandJson {
    return { id: this.id, data: { patch: this.patch as Record<string, unknown> } };
  }
}

/**
 * The values the patch is about to replace — the packet included, because undo has to put the
 * old XMP back rather than re-derive one from the old fields and lose whatever else it held.
 */
function currentValues(doc: Document, patch: MetadataPatch): MetadataPatch {
  const meta = doc.state.metadata as unknown as Record<string, unknown>;
  const before: Record<string, unknown> = { xmp: meta['xmp'] };
  for (const key of Object.keys(patch)) before[key] = meta[key];
  return before;
}

function apply(doc: Document, patch: MetadataPatch, options: { xmp?: boolean } = {}): void {
  doc.setMetadataRecord(patch);
  if (options.xmp === false) return;
  const meta = doc.state.metadata;
  const packet = patchXmp(meta.xmp, xmpFactsOf(meta));
  if (packet !== meta.xmp) doc.setMetadataRecord({ xmp: packet });
}

/** The model's metadata as XMP facts. Empty is `null`, which removes the property. */
export function xmpFactsOf(meta: ModelMetadata): XmpFacts {
  const value = (v: string | null): string | null => (v === null || v === '' ? null : v);
  return {
    title: value(meta.title),
    author: value(meta.author),
    subject: value(meta.subject),
    keywords: value(meta.keywords),
    creator: value(meta.creator),
    producer: value(meta.producer),
    created: value(meta.created),
    modified: value(meta.modified),
    trapped: meta.trapped,
    custom: Object.fromEntries(Object.entries(meta.custom)),
  };
}

/** Changes how the document asks to be opened. */
export class SetInitialViewCommand implements DocumentCommand {
  readonly id = M72_COMMAND_ID.setInitialView;
  readonly label = 'Change initial view';
  readonly writeIntents: ReadonlyArray<WriteIntent> = ['view'];
  private readonly doc: Document;
  private readonly patch: Partial<ViewSettings>;
  private before: Partial<ViewSettings> | null = null;

  constructor(doc: Document, patch: Partial<ViewSettings>) {
    this.doc = doc;
    this.patch = patch;
  }

  do(): void {
    if (this.before === null) {
      const view = this.doc.state.view as unknown as Record<string, unknown>;
      const before: Record<string, unknown> = {};
      for (const key of Object.keys(this.patch)) before[key] = view[key];
      this.before = before;
    }
    this.doc.setViewRecord(this.patch);
  }

  undo(): void {
    if (this.before) this.doc.setViewRecord(this.before);
  }

  toJSON(): CommandJson {
    return { id: this.id, data: { patch: this.patch as Record<string, unknown> } };
  }
}

let registered = false;

/**
 * Registers M72's journal codecs, so an edit made before a crash comes back with the document.
 * Called from the manifest's `activate` and directly by the tests; twice is harmless.
 */
export function registerPropertiesCodecs(): void {
  if (registered) return;
  registered = true;
  registerCommandCodec(M72_COMMAND_ID.setProperties, (doc, payload) => {
    const patch = asRecord(asRecord(payload)?.['patch']);
    return patch ? new SetPropertiesCommand(doc, patch) : null;
  });
  registerCommandCodec(M72_COMMAND_ID.setInitialView, (doc, payload) => {
    const patch = asRecord(asRecord(payload)?.['patch']);
    return patch ? new SetInitialViewCommand(doc, patch) : null;
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}
