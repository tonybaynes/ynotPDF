/**
 * M21 manifest — Save, Save As, autosave and recovery.
 *
 * Everything the reader can reach: two commands with the shortcuts they have everywhere else
 * (Ctrl+S, Ctrl+Shift+S), the File backstage's Save and Save As slots, a Home-ribbon group, a
 * status-bar item that says in a word whether the document is saved, and the recovery command.
 *
 * The service does the work; this file is what the shell needs to know about it. The developer
 * commands at the bottom are how the e2e suite drives a real save through the running app.
 */

import { SERVICE, type ShellServices } from '@app/services';
import { el } from '@app/dom';
import { icon, registerIcon } from '@app/icons';
import { CircleDot, LifeBuoy, SaveAll, Timer } from 'lucide';
import type { UiStore } from '@app/ui/UiState';
import type { Document } from '@core/Document';
import type { ModelId } from '@core/Ids';
import type { Registry } from '@core/Registry';
import {
  DOCUMENT_SERVICE,
  type DocumentService,
} from '@modules/M20-document-model/DocumentService';
import { defineModule, type ServiceContext } from '@shared/module';
import { AddOutlineItemCommand } from './commands';
import { SaveService, SAVE_SERVICE } from './SaveService';
import { SAVE_SETTINGS_SCHEMA, type SaveSettings } from './settings';

export { SaveService, SAVE_SERVICE } from './SaveService';
export type { SaveOutcome, SaveState } from './SaveService';

/**
 * Four icons the shell does not already carry. `registerIcon` is the documented way for a module
 * to add one without editing M02's list (icons.ts), and it happens as this file loads rather than
 * in `activate` — the ribbon and the backstage are built from the manifest before any module is
 * activated, and an icon registered later would already have been drawn as a placeholder.
 */
registerIcon('save-all', SaveAll);
registerIcon('life-buoy', LifeBuoy);
registerIcon('timer', Timer);
registerIcon('circle-dot', CircleDot);

const saves = (ctx: ServiceContext): SaveService => ctx.service<SaveService>(SAVE_SERVICE);

const hasService = (ctx: ServiceContext): boolean =>
  ctx.service<Registry>('registry').hasService(SAVE_SERVICE);

const hasDocument = (ctx: ServiceContext): boolean =>
  hasService(ctx) && ctx.service<DocumentService>(DOCUMENT_SERVICE).active !== null;

/** The active document, or a clear error — running Save with nothing open is a bug. */
function activeDocument(ctx: ServiceContext): Document {
  const doc = ctx.service<DocumentService>(DOCUMENT_SERVICE).active;
  if (!doc) throw new Error('No document is open');
  return doc;
}

/** "Save" or "Save "Report.pdf"" — the ribbon says what it would write. */
function saveLabel(ctx: ServiceContext): string {
  if (!hasService(ctx)) return 'Save';
  const doc = ctx.service<DocumentService>(DOCUMENT_SERVICE).active;
  const state = doc ? saves(ctx).state(doc.id) : null;
  if (state?.readOnly) return 'Save As…';
  return 'Save';
}

export default defineModule({
  id: 'M21',
  name: 'Save',

  activate(ctx) {
    const registry = ctx.service<Registry>('registry');
    if (registry.hasService(SAVE_SERVICE)) return undefined;
    if (!registry.hasService('shellServices') || !registry.hasService(DOCUMENT_SERVICE)) {
      return undefined;
    }
    const shell = registry.service<ShellServices>('shellServices');
    const service = new SaveService({ registry, shell });
    registry.provide(SAVE_SERVICE, service);
    void service.load().then(() => service.offerRecovery());
    return () => {
      service.dispose();
    };
  },

  settings: SAVE_SETTINGS_SCHEMA,

  commands: [
    {
      id: 'file.save',
      label: 'Save',
      category: 'File',
      icon: 'save',
      shortcut: 'Mod+S',
      description: 'Write the document back to the file it came from',
      when: hasDocument,
      run: (ctx) => saves(ctx).save(activeDocument(ctx)),
    },
    {
      id: 'file.saveAs',
      label: 'Save As…',
      category: 'File',
      icon: 'save-all',
      shortcut: 'Mod+Shift+S',
      description: 'Write the document to a new file',
      when: hasDocument,
      run: (ctx) => saves(ctx).saveAs(activeDocument(ctx)),
    },
    {
      id: 'file.recover',
      label: 'Recover Unsaved Work…',
      category: 'File',
      icon: 'history',
      description: 'Put back documents that were open when ynotPDF last stopped',
      when: hasService,
      run: (ctx) => saves(ctx).offerRecovery(),
    },
    {
      id: 'file.autosaveNow',
      label: 'Save Recovery Information Now',
      category: 'File',
      icon: 'life-buoy',
      description: 'Write the recovery record for every changed document straight away',
      when: hasService,
      run: async (ctx) => ({ written: await saves(ctx).autosaveNow() }),
    },
    {
      id: 'file.closeAll',
      label: 'Close All',
      category: 'File',
      icon: 'x',
      description: 'Close every open document, asking about anything unsaved',
      when: hasDocument,
      // `Documents.closeAll` runs the before-close hook for each tab, and M21's hook is what asks
      // about unsaved work — so asking here as well would put the same question twice per
      // document, and a reader who answered once would find it still in the way.
      run: (ctx) => ctx.service<ShellServices>('shellServices').documents.closeAll(),
    },
    {
      id: 'file.setting.keepBackup',
      label: 'Keep a Backup Copy When Saving',
      category: 'File',
      icon: 'copy',
      description: 'Rename the previous version to .bak on every save',
      when: hasService,
      run: (ctx) => {
        const service = saves(ctx);
        const next = ctx.args['value'];
        const value = typeof next === 'boolean' ? next : !service.settings.keepBackup;
        return service.setSetting('keepBackup', value);
      },
    },
    {
      id: 'file.setting.autosaveMinutes',
      label: 'Autosave Interval…',
      category: 'File',
      icon: 'timer',
      description: 'Minutes between recovery saves; 0 turns autosave off (pass { minutes })',
      when: hasService,
      run: async (ctx) => {
        const service = saves(ctx);
        const minutes = ctx.args['minutes'];
        if (typeof minutes !== 'number') return service.settings.autosaveMinutes;
        return service.setSetting('autosaveMinutes', Math.max(0, Math.min(120, minutes)));
      },
    },

    // ---- developer commands: how the e2e suite drives a real save ------------------------------
    {
      id: 'dev.saveState',
      label: 'Save: report the state',
      category: 'Developer',
      icon: 'list-tree',
      description: 'Path, read-only, dirty and the plan the next save would use',
      when: hasDocument,
      run: (ctx) => {
        const doc = activeDocument(ctx);
        const service = saves(ctx);
        const state = service.state(doc.id);
        return {
          documentId: doc.id,
          title: doc.state.title,
          path: state?.path ?? null,
          readOnly: state?.readOnly ?? false,
          readOnlyReason: state?.readOnlyReason ?? '',
          dirty: doc.isDirty,
          saving: state?.saving ?? false,
          writeIntents: [...doc.state.writeIntents],
          settings: { ...service.settings },
        };
      },
    },
    {
      id: 'dev.addBookmark',
      label: 'Document: add a bookmark',
      category: 'Developer',
      icon: 'bookmark',
      description: 'Adds an outline entry pointing at a page — scaffolding until M12 lands',
      when: hasDocument,
      run: async (ctx) => {
        const doc = activeDocument(ctx);
        const title = typeof ctx.args['title'] === 'string' ? ctx.args['title'] : 'Bookmark';
        const pageArg = ctx.args['pageId'];
        const pageId =
          typeof pageArg === 'string'
            ? (pageArg as ModelId)
            : doc.page(typeof ctx.args['page'] === 'number' ? ctx.args['page'] : 0).id;
        const command = new AddOutlineItemCommand(doc, { title, target: { pageId, fit: 'fit' } });
        await doc.apply(command);
        return { id: command.outlineId, outline: doc.state.outline.map((o) => o.title) };
      },
    },
    {
      id: 'dev.recoveryList',
      label: 'Save: list recoverable documents',
      category: 'Developer',
      icon: 'life-buoy',
      description: 'What the recovery store holds right now',
      when: hasService,
      run: async (ctx) => {
        const records = await saves(ctx).listRecoverable();
        return records.map((r) => ({
          id: r.id,
          title: r.title,
          path: r.path,
          changes: r.changes,
          savedAt: r.savedAt,
        }));
      },
    },
    {
      id: 'dev.recoverAll',
      label: 'Save: recover everything without asking',
      category: 'Developer',
      icon: 'rotate-ccw',
      description: 'Replays every recovery record — the e2e crash test uses this',
      when: hasService,
      run: async (ctx) => {
        const service = saves(ctx);
        const records = await service.listRecoverable();
        let recovered = 0;
        for (const record of records) {
          if (await service.recoverOne(record)) recovered++;
        }
        return { found: records.length, recovered };
      },
    },
  ],

  ribbon: [
    {
      id: 'home.file',
      tab: 'home',
      label: 'File',
      order: 5,
      large: ['file.save'],
      items: [
        { kind: 'button', command: 'file.save', size: 'large', dynamicLabel: saveLabel },
        { kind: 'button', command: 'file.saveAs', size: 'small' },
      ],
    },
  ],

  backstage: [
    { slot: 'save', command: 'file.save', icon: 'save' },
    { slot: 'saveAs', command: 'file.saveAs', icon: 'save-all' },
  ],

  statusBar: [
    {
      id: 'save.status',
      slot: 'right',
      order: 5,
      mount: (host, ctx) => mountSaveStatus(host, ctx),
    },
  ],

  contextMenus: [
    {
      id: 'save.tabMenu',
      region: 'tab',
      order: 5,
      items: [{ command: 'file.save' }, { command: 'file.saveAs' }],
    },
  ],
});

/**
 * The status-bar item: "Saved", "Unsaved changes", "Read-only" or "Saving…" — a word and an
 * icon, never a colour on its own, and never a bare dot the reader has to interpret.
 */
function mountSaveStatus(host: HTMLElement, ctx: ServiceContext): () => void {
  const registry = ctx.service<Registry>('registry');
  const item = el('span.status-save', { 'aria-live': 'polite' });
  const glyph = el('span.status-save-icon', { 'aria-hidden': 'true' });
  const word = el('span.status-save-word');
  item.append(glyph, word);
  host.append(item);

  const render = (): void => {
    if (!registry.hasService(SAVE_SERVICE) || !registry.hasService(DOCUMENT_SERVICE)) {
      item.hidden = true;
      return;
    }
    const service = registry.service<SaveService>(SAVE_SERVICE);
    const doc = registry.service<DocumentService>(DOCUMENT_SERVICE).active;
    if (!doc) {
      item.hidden = true;
      return;
    }
    item.hidden = false;
    const state = service.state(doc.id);
    const [name, text, title] = state?.saving
      ? (['loader', 'Saving…', 'The document is being written'] as const)
      : state?.readOnly
        ? (['lock', 'Read-only', `Cannot be saved where it is: ${state.readOnlyReason}`] as const)
        : doc.isDirty
          ? (['circle-dot', 'Unsaved changes', 'Press Ctrl+S to save'] as const)
          : (['circle-check', 'Saved', 'Everything is written to disk'] as const);
    glyph.replaceChildren(icon(name));
    word.textContent = text;
    item.title = title;
    item.dataset['state'] = text;
  };

  render();
  const stop = ctx.service<UiStore>(SERVICE.ui).subscribe(render);
  return () => {
    stop();
    item.remove();
  };
}

export type { SaveSettings };
