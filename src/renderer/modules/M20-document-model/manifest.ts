/**
 * M20 manifest — undo, redo and the document service.
 *
 * The model itself lives in `src/renderer/core/`; this module is what the user can reach. Undo
 * and Redo are ordinary registered commands, so they appear in the command palette, on the Edit
 * ribbon tab and in the quick-access toolbar (whose default already lists them), and their
 * ribbon buttons rename themselves to say what they would revert — "Undo Rotate page" — through
 * the `dynamicLabel` hook added by ADR 0008.
 *
 * The developer commands at the bottom are how the e2e suite drives a real document through the
 * running app: they open a fixture, apply commands and report the model back as plain data.
 */

import { SERVICE } from '@app/services';
import type { ShellServices } from '@app/services';
import type { Documents } from '@app/tabs/Documents';
import type { Document } from '@core/Document';
import {
  DeletePagesCommand,
  InsertPagesCommand,
  MovePageCommand,
  RotatePagesCommand,
  SetMetadataCommand,
  SetPageLabelCommand,
  defaultPageSize,
} from '@core/commands';
import type { ModelId } from '@core/Ids';
import { serialiseJournal, replayJournal, type JournalFile } from '@core/Journal';
import type { Registry } from '@core/Registry';
import type { EngineClient } from '@engine/EngineClient';
import type { Rotation } from '@shared/pdf';
import { defineModule, type ServiceContext } from '@shared/module';
import { DocumentService, DOCUMENT_SERVICE } from './DocumentService';

export { DocumentService, DOCUMENT_SERVICE } from './DocumentService';

const docs = (ctx: ServiceContext): DocumentService =>
  ctx.service<DocumentService>(DOCUMENT_SERVICE);

/** True when the service exists at all — it does not while the shell is still booting. */
const hasService = (ctx: ServiceContext): boolean =>
  ctx.service<Registry>('registry').hasService(DOCUMENT_SERVICE);

const canUndo = (ctx: ServiceContext): boolean => hasService(ctx) && docs(ctx).undoState.canUndo;
const canRedo = (ctx: ServiceContext): boolean => hasService(ctx) && docs(ctx).undoState.canRedo;

/** "Undo" alone, or "Undo Rotate page" when there is something to revert (Foxit's wording). */
function undoLabel(ctx: ServiceContext): string {
  const label = hasService(ctx) ? docs(ctx).undoState.undoLabel : null;
  return label ? `Undo ${label}` : 'Undo';
}

function redoLabel(ctx: ServiceContext): string {
  const label = hasService(ctx) ? docs(ctx).undoState.redoLabel : null;
  return label ? `Redo ${label}` : 'Redo';
}

/** The active document, or a clear error — a developer command with no document is a bug. */
function activeDocument(ctx: ServiceContext): Document {
  const doc = docs(ctx).active;
  if (!doc) throw new Error('No document is open');
  return doc;
}

function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  return null;
}

/** A string argument, or the fallback when the caller passed something else. */
function stringArg(args: Readonly<Record<string, unknown>>, key: string, fallback: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : fallback;
}

function pageIdArg(doc: Document, args: Readonly<Record<string, unknown>>): ModelId {
  const id = args['pageId'];
  if (typeof id === 'string') return id as ModelId;
  const index = typeof args['page'] === 'number' ? args['page'] : 0;
  return doc.page(index).id;
}

export default defineModule({
  id: 'M20',
  name: 'Document model',

  activate(ctx) {
    const registry = ctx.service<Registry>('registry');
    if (registry.hasService(DOCUMENT_SERVICE)) return undefined;
    const shell = registry.hasService('shellServices')
      ? registry.service<ShellServices>('shellServices')
      : null;
    const documents = registry.service<Documents>(SERVICE.documents);
    const engine = registry.service<EngineClient>('engineClient').engine;
    const service = new DocumentService(documents, engine, () => shell?.invalidate());
    registry.provide(DOCUMENT_SERVICE, service);
    return () => {
      void service.disposeAll();
    };
  },

  commands: [
    {
      id: 'edit.undo',
      label: 'Undo',
      category: 'Edit',
      icon: 'undo-2',
      shortcut: 'Mod+Z',
      description: 'Reverse the last change to the document',
      when: canUndo,
      run: async (ctx) => {
        const doc = docs(ctx).active;
        if (!doc) return null;
        const label = doc.undo.state.undoLabel;
        await doc.undoLast();
        return label;
      },
    },
    {
      id: 'edit.redo',
      label: 'Redo',
      category: 'Edit',
      icon: 'redo-2',
      shortcut: 'Mod+Y',
      description: 'Re-apply the change that was last undone',
      when: canRedo,
      run: async (ctx) => {
        const doc = docs(ctx).active;
        if (!doc) return null;
        const label = doc.undo.state.redoLabel;
        await doc.redoLast();
        return label;
      },
    },

    // ---- page commands, so the model is reachable before M40 lands ------------------------------
    {
      id: 'page.rotateRight',
      label: 'Rotate Right',
      category: 'Organize',
      icon: 'rotate-cw',
      description: 'Turn the current page 90° clockwise',
      when: (ctx) => hasService(ctx) && docs(ctx).active !== null,
      run: async (ctx) => {
        const doc = activeDocument(ctx);
        const pageId = pageIdArg(doc, ctx.args);
        await doc.apply(new RotatePagesCommand(doc, [pageId], 90, true));
        return doc.pageById(pageId)?.rotation ?? null;
      },
    },
    {
      id: 'page.rotateLeft',
      label: 'Rotate Left',
      category: 'Organize',
      icon: 'rotate-ccw',
      description: 'Turn the current page 90° anticlockwise',
      when: (ctx) => hasService(ctx) && docs(ctx).active !== null,
      run: async (ctx) => {
        const doc = activeDocument(ctx);
        const pageId = pageIdArg(doc, ctx.args);
        await doc.apply(new RotatePagesCommand(doc, [pageId], 270, true));
        return doc.pageById(pageId)?.rotation ?? null;
      },
    },

    // ---- developer commands: how the e2e suite drives a real document ---------------------------
    {
      id: 'dev.documentOpen',
      label: 'Document: open bytes into a tab',
      category: 'Developer',
      icon: 'file-input',
      description: 'Opens a PDF as a Document and reports its model summary',
      run: async (ctx) => {
        const bytes = toBytes(ctx.args['bytes']);
        if (!bytes) throw new Error('dev.documentOpen needs { bytes }');
        const name = typeof ctx.args['name'] === 'string' ? ctx.args['name'] : 'document.pdf';
        const { document } = await docs(ctx).open(bytes, { name });
        return summarise(document);
      },
    },
    {
      id: 'dev.documentApply',
      label: 'Document: apply a model command',
      category: 'Developer',
      icon: 'wand-2',
      description: 'Applies one command by kind: rotate, insert, delete, move, label, metadata',
      when: (ctx) => hasService(ctx) && docs(ctx).active !== null,
      run: async (ctx) => {
        const doc = activeDocument(ctx);
        const kind = stringArg(ctx.args, 'kind', 'rotate');
        switch (kind) {
          case 'rotate': {
            const rotation = Number(ctx.args['rotation'] ?? 90) as Rotation;
            await doc.apply(
              new RotatePagesCommand(doc, [pageIdArg(doc, ctx.args)], rotation, true),
            );
            break;
          }
          case 'insert':
            await doc.apply(
              new InsertPagesCommand(
                doc,
                Number(ctx.args['at'] ?? doc.pageCount),
                Number(ctx.args['count'] ?? 1),
                defaultPageSize(doc),
              ),
            );
            break;
          case 'delete':
            await doc.apply(new DeletePagesCommand(doc, [pageIdArg(doc, ctx.args)]));
            break;
          case 'move':
            await doc.apply(
              new MovePageCommand(doc, pageIdArg(doc, ctx.args), Number(ctx.args['to'] ?? 0)),
            );
            break;
          case 'label':
            await doc.apply(
              new SetPageLabelCommand(
                doc,
                pageIdArg(doc, ctx.args),
                stringArg(ctx.args, 'value', ''),
              ),
            );
            break;
          case 'metadata':
            await doc.apply(
              new SetMetadataCommand(doc, { title: stringArg(ctx.args, 'value', 'Untitled') }),
            );
            break;
          default:
            throw new Error(`Unknown command kind: ${kind}`);
        }
        return summarise(doc);
      },
    },
    {
      id: 'dev.documentSummary',
      label: 'Document: report the model',
      category: 'Developer',
      icon: 'list-tree',
      description: 'Pages, annotations, undo labels, write intents and validation issues',
      when: (ctx) => hasService(ctx) && docs(ctx).active !== null,
      run: (ctx) => summarise(activeDocument(ctx)),
    },
    {
      id: 'dev.documentJournal',
      label: 'Document: serialise the journal',
      category: 'Developer',
      icon: 'scroll-text',
      description: 'The undo history as JSON, and optionally replay one back into the document',
      when: (ctx) => hasService(ctx) && docs(ctx).active !== null,
      run: async (ctx) => {
        const doc = activeDocument(ctx);
        const replay = ctx.args['replay'];
        if (replay && typeof replay === 'object') {
          const file = replay as JournalFile;
          return await replayJournal(doc, file.entries);
        }
        return serialiseJournal(doc);
      },
    },
  ],

  // The Organize tab's Rotate group was here as scaffolding "until M40 lands". M40 owns that
  // tab now and its rotate commands act on the *selected* pages, where these two act on a page
  // named by argument and default to the first — which is not what a button on the Organize tab
  // means. The commands stay (M11 and the e2e suite call them by id); only the ribbon group went.
  ribbon: [
    {
      id: 'edit.history',
      tab: 'edit',
      label: 'Undo',
      order: 10,
      large: ['edit.undo', 'edit.redo'],
      items: [
        { kind: 'button', command: 'edit.undo', size: 'large', dynamicLabel: undoLabel },
        { kind: 'button', command: 'edit.redo', size: 'large', dynamicLabel: redoLabel },
      ],
    },
  ],

  // Ctrl+Y is the Windows convention and Ctrl+Shift+Z the Mac one; Foxit accepts both everywhere.
  shortcuts: [{ key: 'Mod+Shift+Z', command: 'edit.redo' }],
});

/** A structured-cloneable view of the model, for the e2e harness and the developer commands. */
function summarise(doc: Document): Record<string, unknown> {
  const s = doc.state;
  const undo = doc.undo.state;
  return {
    id: doc.id,
    title: s.title,
    pageCount: s.pages.length,
    pageLabels: s.pages.map((p) => p.label),
    pageIds: s.pages.map((p) => String(p.id)),
    rotations: s.pages.map((p) => p.rotation),
    annotationCount: Object.values(s.annotations).reduce((n, list) => n + list.length, 0),
    fieldCount: s.fields.length,
    outlineCount: s.outline.length,
    destinationCount: s.destinations.length,
    layerCount: s.layers.length,
    attachmentCount: s.attachments.length,
    signatureCount: s.signatures.length,
    metadataTitle: s.metadata.title,
    writeIntents: [...s.writeIntents],
    revision: s.revision,
    dirty: doc.isDirty,
    canUndo: undo.canUndo,
    canRedo: undo.canRedo,
    undoLabel: undo.undoLabel,
    redoLabel: undo.redoLabel,
    issues: doc.validate().map((i) => i.code),
  };
}
