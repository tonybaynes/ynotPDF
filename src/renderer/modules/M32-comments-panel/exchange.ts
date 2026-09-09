/**
 * Import and export of comments (M32): the bridge between `engine/xfdf/`, which is pure, and the
 * document, which is a journal of commands.
 *
 * **Export** turns each annotation into an exchange record. `/IRT` is by `/NM`, and an annotation
 * that has none is given a synthetic one *in the exported file only* — nothing is written to the
 * document by an export, and a thread that would otherwise arrive as loose notes is worth more
 * than a name the reader will never see.
 *
 * **Import** merges. `replace` overwrites the annotation with the same `/NM`, which is what makes
 * a second round of review from the same reviewer replace the first rather than double it;
 * `add` gives every incoming comment a fresh `/NM` so nothing is lost. Both run inside one
 * `document.batch`, so an import is one undo step however many comments it brought.
 *
 * Replies are resolved after the pass that creates the comments, by name, because an export is
 * free to list a reply before its target and several do.
 */

import type { Document } from '@core/Document';
import type { ModelId } from '@core/Ids';
import { AddAnnotationCommand, DeleteAnnotationCommand, draftAnnotation } from '@core/commands';
import type { ModelAnnotation } from '@core/model';
import {
  patchFrom,
  toXfdf,
  writeFdf,
  writeXfdf,
  type CommentFormat,
  type XfdfAnnotation,
  type XfdfDocument,
  type XfdfField,
} from '@engine/xfdf';
import type { AnnotationService } from '@modules/M30-markup-annotations/AnnotationService';
import { isComment } from './model';
import { newName } from './CommentsService';
import type { ImportPolicy } from './settings';

export interface ExportOptions {
  readonly format: CommentFormat;
  /** Include AcroForm field values beside the comments. */
  readonly formData: boolean;
  /** Only these annotation ids; absent means every comment in the document. */
  readonly only?: ReadonlySet<ModelId> | undefined;
}

/** Builds the exchange document for a PDF. Pure over the model: nothing is written. */
export function exportComments(document: Document, options: ExportOptions): XfdfDocument {
  const pageIndex = new Map(document.state.pages.map((page, at) => [page.id, at]));
  const all: ModelAnnotation[] = [];
  for (const page of document.state.pages) all.push(...document.annotations(page.id));

  // A name for every annotation that might be pointed at, invented here when the file has none.
  // It never reaches the document — an export must not dirty what it is exporting.
  const names = new Map<ModelId, string>();
  const used = new Set<string>();
  for (const a of all) {
    if (a.name !== null && a.name !== '' && !used.has(a.name)) {
      names.set(a.id, a.name);
      used.add(a.name);
    }
  }
  for (const a of all) {
    if (names.has(a.id)) continue;
    let name = newName();
    while (used.has(name)) name = newName();
    names.set(a.id, name);
    used.add(name);
  }

  const wanted = (a: ModelAnnotation): boolean =>
    isComment(a) && (options.only === undefined || options.only.has(a.id) || replyOfWanted(a));
  const replyOfWanted = (a: ModelAnnotation): boolean =>
    a.inReplyTo !== null && options.only?.has(a.inReplyTo) === true;

  const annotations: XfdfAnnotation[] = all.filter(wanted).map((a) => ({
    ...toXfdf(a, {
      page: (target) => pageIndex.get(target.pageId) ?? 0,
      nameOf: (id) => names.get(id) ?? null,
    }),
    name: names.get(a.id) ?? null,
  }));

  const fields: XfdfField[] = options.formData
    ? document.state.fields
        .filter((field) => field.value !== '')
        .map((field) => ({ name: field.name, value: field.value }))
    : [];

  return {
    href: document.state.path ?? document.state.title,
    ids: null,
    annotations,
    fields,
  };
}

/** Serialises an exchange document in the format asked for. */
export function serialiseComments(doc: XfdfDocument, format: CommentFormat): Uint8Array {
  return format === 'fdf' ? writeFdf(doc) : new TextEncoder().encode(writeXfdf(doc));
}

export interface ImportResult {
  readonly added: number;
  readonly replaced: number;
  /** Comments the file put on a page the document does not have. */
  readonly offPage: number;
  readonly replies: number;
}

/**
 * Merges an exchange document into a PDF. One `document.batch`, so it is one undo step.
 *
 * `pageOffset` lets a caller import onto a different page than the file names — M120's batch
 * will want it; the panel always passes 0.
 */
export async function importComments(
  document: Document,
  annotations: AnnotationService,
  source: XfdfDocument,
  options: { readonly policy: ImportPolicy; readonly pageOffset?: number },
): Promise<ImportResult> {
  const offset = options.pageOffset ?? 0;
  const pages = document.state.pages;
  let added = 0;
  let replaced = 0;
  let offPage = 0;
  let replies = 0;

  // Existing comments by `/NM`, for the replace policy.
  const existing = new Map<string, ModelAnnotation>();
  for (const page of pages) {
    for (const a of document.annotations(page.id)) {
      if (a.name !== null && a.name !== '') existing.set(a.name, a);
    }
  }

  /** Incoming name → the model id it ended up with, for the reply pass. */
  const landed = new Map<string, ModelId>();
  const taken = new Set(existing.keys());

  await document.batch('Import comments', async () => {
    for (const incoming of source.annotations) {
      const pageIndex = incoming.page + offset;
      const page = pages[pageIndex];
      if (!page) {
        offPage++;
        continue;
      }
      const patch = patchFrom(incoming);
      const previous =
        options.policy === 'replace' && incoming.name !== null
          ? existing.get(incoming.name)
          : undefined;

      if (previous?.subtype === incoming.subtype && previous.pageId === page.id) {
        // The same comment, come round again: overwrite it in place so its position in the file
        // and anything already replying to it survive.
        await annotations.patch(previous.id, patch);
        landed.set(incoming.name ?? previous.id, previous.id);
        replaced++;
        continue;
      }
      if (previous) {
        // Same name, different comment: the name has to give way rather than the comment.
        await document.apply(new DeleteAnnotationCommand(document, previous.id));
        existing.delete(incoming.name ?? '');
      }

      let name = incoming.name;
      if (options.policy === 'add' || name === null || name === '' || taken.has(name)) {
        name = newName();
        while (taken.has(name)) name = newName();
      }
      taken.add(name);

      const draft = draftAnnotation(document, page.id, {
        subtype: incoming.subtype,
        rect: incoming.rect,
        flags: incoming.flags,
        ...patchToEngine(patch),
        name,
      });
      await document.apply(new AddAnnotationCommand(document, draft));
      annotations.markEdited(draft.id);
      if (incoming.name !== null) landed.set(incoming.name, draft.id);
      added++;
    }

    // Second pass: now that every comment exists, thread the replies. An export is free to list a
    // reply before its target — several producers do — so this cannot be done in the first pass.
    for (const incoming of source.annotations) {
      if (incoming.inReplyTo === null || incoming.name === null) continue;
      const child = landed.get(incoming.name);
      const parent = landed.get(incoming.inReplyTo) ?? existing.get(incoming.inReplyTo)?.id;
      if (child === undefined || parent === undefined || child === parent) continue;
      await annotations.patch(child, {
        inReplyTo: parent,
        extra: replyExtra(document, child),
      });
      annotations.markEdited(parent);
      replies++;
    }
  });

  return { added, replaced, offPage, replies };
}

/** `/RT` defaults to `/R` for anything that has an `/IRT` and does not say otherwise. */
function replyExtra(document: Document, id: ModelId): Record<string, unknown> {
  const current = document.annotation(id);
  const extra = { ...(current?.extra ?? {}) };
  if (typeof extra['replyType'] !== 'string' || extra['replyType'] === '') {
    extra['replyType'] = 'R';
  }
  return extra;
}

/**
 * The patch, as the fields `draftAnnotation` wants. It takes an engine-shaped annotation, where
 * geometry is `quadPoints`/`paths` and there is no `vertices` — a shape's vertices are its first
 * path.
 */
function patchToEngine(patch: ReturnType<typeof patchFrom>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    contents: patch.contents ?? undefined,
    author: patch.author ?? undefined,
    created: patch.created ?? undefined,
    modified: patch.modified ?? undefined,
    subject: patch.subject ?? undefined,
    color: patch.color ?? undefined,
    interiorColor: patch.interiorColor ?? undefined,
    opacity: patch.opacity ?? undefined,
    borderWidth: patch.borderWidth ?? undefined,
    state: patch.state ?? undefined,
    extra: patch.extra ?? {},
  };
  if (patch.quadPoints && patch.quadPoints.length > 0) out['quadPoints'] = patch.quadPoints;
  if (patch.paths && patch.paths.length > 0) out['paths'] = patch.paths;
  else if (patch.vertices && patch.vertices.length > 0) out['paths'] = [patch.vertices];
  // An absent value must not reach  as :
  // treats a present-but-undefined key as an error, and the model wants the key simply gone.
  return Object.fromEntries(Object.entries(out).filter(([, value]) => value !== undefined));
}
