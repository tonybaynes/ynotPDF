/**
 * M12 manifest — the five navigation panels, their commands, the View ribbon group and the
 * shortcuts.
 *
 * Everything a reader can do here is a registered command, so it is in the command palette and
 * the e2e suite can drive it: the panels' own toolbar buttons call these by id rather than doing
 * the work themselves. The document changes are the `Command`s in `commands.ts`; this file is
 * the wiring.
 */

import { registerIcon } from '@app/icons';
import type { ShellServices } from '@app/services';
import { SERVICE } from '@app/services';
import type { PanelsService } from '@app/panes/NavPane';
import { field } from '@app/dialog/Dialogs';
import { el } from '@app/dom';
import type { Document } from '@core/Document';
import type { ModelId } from '@core/Ids';
import { SetLayerVisibleCommand } from '@core/commands';
import type { Registry } from '@core/Registry';
import type { EngineClient } from '@engine/EngineClient';
import { hasBridge, invoke } from '@shared/ipc';
import { defineModule, type CommandSpec, type ServiceContext } from '@shared/module';
import { Crosshair } from 'lucide';
import {
  AddBookmarkCommand,
  AddDestinationCommand,
  AddAttachmentCommand,
  DeleteAttachmentCommand,
  DeleteBookmarkCommand,
  DeleteDestinationCommand,
  DescribeAttachmentCommand,
  MoveBookmarkCommand,
  RenameBookmarkCommand,
  RenameDestinationCommand,
  SetBookmarkStyleCommand,
  SetBookmarkTargetCommand,
  SetDestinationCommand,
  registerNavigationCodecs,
} from './commands';
import { NavigationService, NAVIGATION_SERVICE, PANEL_ID } from './NavigationService';
import { mountAttachmentPanel } from './attachments/AttachmentPanel';
import { mountBookmarkPanel } from './bookmarks/BookmarkPanel';
import { mountDestinationPanel } from './destinations/DestinationPanel';
import {
  mountLayerPanel,
  layerStateOf,
  parseLayerState,
  type LayerState,
} from './layers/LayerPanel';
import { mountThumbnailPanel } from './thumbnails/ThumbnailPanel';
import { expandToLevel, indent, maxDepth, outdent, positionOf } from './bookmarks/tree';
import { canStep, stepSize } from './thumbnails/grid';
import { LEFT_PANE_ON_OPEN, NAVIGATION_SETTINGS_SCHEMA, type LeftPaneOnOpen } from './settings';

export { NavigationService, NAVIGATION_SERVICE, PANEL_ID } from './NavigationService';
export { registerNavigationCodecs } from './commands';

/** Set in `activate`, so the panels reach the live service without a captured context. */
let live: NavigationService | null = null;

const nav = (ctx: ServiceContext): NavigationService =>
  ctx.service<NavigationService>(NAVIGATION_SERVICE);

const hasNav = (ctx: ServiceContext): boolean =>
  ctx.service<Registry>('registry').hasService(NAVIGATION_SERVICE);

/** True when a document is open — every editing command is gated on this. */
const hasDocument = (ctx: ServiceContext): boolean => hasNav(ctx) && nav(ctx).document !== null;

/**
 * A document whose embedded files this panel may *edit* (M42).
 *
 * A portfolio's files are structure — folder, order, column values — and M42 holds that
 * structure in the document alongside the engine's list. Adding or deleting one from here would
 * go behind its back, and the next portfolio save would rebuild the name tree without the
 * change. So on a portfolio these commands stand down and the Portfolio tab does the work; a
 * build without M42 has no portfolio service and nothing changes.
 */
const editableAttachments = (ctx: ServiceContext): boolean => {
  if (!hasDocument(ctx)) return false;
  const registry = ctx.service<Registry>('registry');
  if (!registry.hasService('portfolio')) return true;
  return !registry.service<{ isPortfolio: boolean }>('portfolio').isPortfolio;
};

/** The active document, or a clear error. Commands reaching this are gated on `when`. */
function doc(ctx: ServiceContext): Document {
  const document = hasNav(ctx) ? nav(ctx).document : null;
  if (!document) throw new Error('No document is open');
  return document;
}

/** The bookmark a command acts on: the argument, else the panel's selection. */
function bookmarkOf(ctx: ServiceContext & { args?: Readonly<Record<string, unknown>> }): ModelId {
  const fromArgs = ctx.args?.['bookmark'];
  const id = typeof fromArgs === 'string' ? (fromArgs as ModelId) : nav(ctx).selectedBookmark;
  if (id === null || id === undefined) throw new Error('Select a bookmark first');
  return id;
}

function destinationOf(
  ctx: ServiceContext & { args?: Readonly<Record<string, unknown>> },
): ModelId {
  const fromArgs = ctx.args?.['destination'];
  const id = typeof fromArgs === 'string' ? (fromArgs as ModelId) : nav(ctx).selectedDestination;
  if (id === null || id === undefined) throw new Error('Select a destination first');
  return id;
}

function attachmentOf(ctx: ServiceContext & { args?: Readonly<Record<string, unknown>> }): ModelId {
  const fromArgs = ctx.args?.['attachment'];
  const id = typeof fromArgs === 'string' ? (fromArgs as ModelId) : nav(ctx).selectedAttachment;
  if (id === null || id === undefined) throw new Error('Select an attachment first');
  return id;
}

/** A panel toggle command with a real label and a shortcut, rather than the generated one. */
function panelCommand(spec: {
  id: string;
  panel: string;
  label: string;
  icon: string;
  shortcut: string;
  description: string;
}): CommandSpec {
  return {
    id: spec.id,
    label: spec.label,
    category: 'View',
    icon: spec.icon,
    shortcut: spec.shortcut,
    description: spec.description,
    run: (ctx) => {
      const panels = ctx.service<PanelsService>(SERVICE.panels);
      panels.toggle(spec.panel);
      return panels.active;
    },
  };
}

const PANEL_COMMANDS: ReadonlyArray<CommandSpec> = [
  panelCommand({
    id: 'view.panel.pages',
    panel: PANEL_ID.pages,
    label: 'Pages Panel',
    icon: 'gallery-vertical',
    shortcut: 'Mod+Shift+1',
    description: 'Page thumbnails — the panel a document opens on',
  }),
  panelCommand({
    id: 'view.panel.bookmarks',
    panel: PANEL_ID.bookmarks,
    label: 'Bookmarks Panel',
    icon: 'bookmark',
    shortcut: 'Mod+Shift+2',
    description: "The document's outline, as an editable tree",
  }),
  panelCommand({
    id: 'view.panel.layers',
    panel: PANEL_ID.layers,
    label: 'Layers Panel',
    icon: 'layers',
    shortcut: 'Mod+Shift+3',
    description: 'Optional-content groups and their visibility',
  }),
  panelCommand({
    id: 'view.panel.attachments',
    panel: PANEL_ID.attachments,
    label: 'Attachments Panel',
    icon: 'paperclip',
    shortcut: 'Mod+Shift+4',
    description: 'Embedded files, and the contents of a PDF Portfolio',
  }),
  panelCommand({
    id: 'view.panel.destinations',
    panel: PANEL_ID.destinations,
    label: 'Destinations Panel',
    icon: 'tag',
    shortcut: 'Mod+Shift+5',
    description: 'Named destinations in the document',
  }),
];

/** Which panel a document opens on — the operator's setting, offered wherever it is useful. */
const DEFAULT_PANEL_COMMAND: CommandSpec = {
  id: 'view.panel.defaultOnOpen',
  label: 'Open this panel by default…',
  category: 'View',
  icon: 'panel-left',
  description: 'Choose what the navigation pane shows when a document opens (pass { value })',
  when: hasNav,
  run: async (ctx) => {
    const value = ctx.args['value'];
    const service = nav(ctx);
    if (typeof value === 'string' && LEFT_PANE_ON_OPEN.some((o) => o.value === value)) {
      return await service.setSetting('leftPaneOnOpen', value as LeftPaneOnOpen);
    }
    const choice = await service.dialogs.open({
      title: 'When a document opens, show',
      id: 'nav-default-panel',
      content: (body) => {
        const select = el('select.input');
        for (const option of LEFT_PANE_ON_OPEN) {
          const item = el('option', { value: option.value }, option.label);
          if (option.value === service.settings.leftPaneOnOpen) item.setAttribute('selected', '');
          select.append(item);
        }
        select.id = 'nav-default-panel-select';
        body.append(field({ label: 'Navigation pane', input: select }));
      },
      buttons: [
        { id: 'cancel', label: 'Cancel' },
        { id: 'ok', label: 'Save', primary: true },
      ],
    }).result;
    if (choice !== 'ok') return service.settings.leftPaneOnOpen;
    const select = document.getElementById('nav-default-panel-select');
    const chosen = select instanceof HTMLSelectElement ? select.value : null;
    if (chosen === null) return service.settings.leftPaneOnOpen;
    return await service.setSetting('leftPaneOnOpen', chosen as LeftPaneOnOpen);
  },
};

const THUMBNAIL_COMMANDS: ReadonlyArray<CommandSpec> = [
  {
    id: 'view.thumbnails.larger',
    label: 'Larger Thumbnails',
    category: 'View',
    icon: 'plus',
    description: 'Step the page thumbnails up a size and widen the pane to fit one column',
    when: (ctx) => hasNav(ctx) && canStep(nav(ctx).settings.thumbnailSize, 1),
    run: async (ctx) =>
      await nav(ctx).setThumbnailSize(stepSize(nav(ctx).settings.thumbnailSize, 1)),
  },
  {
    id: 'view.thumbnails.smaller',
    label: 'Smaller Thumbnails',
    category: 'View',
    icon: 'minus',
    description: 'Step the page thumbnails down a size and narrow the pane to fit one column',
    when: (ctx) => hasNav(ctx) && canStep(nav(ctx).settings.thumbnailSize, -1),
    run: async (ctx) =>
      await nav(ctx).setThumbnailSize(stepSize(nav(ctx).settings.thumbnailSize, -1)),
  },
];

const BOOKMARK_COMMANDS: ReadonlyArray<CommandSpec> = [
  {
    id: 'bookmarks.add',
    label: 'Add Bookmark',
    category: 'View',
    icon: 'bookmark',
    shortcut: 'Mod+B',
    description: 'Add a bookmark pointing at the current view (pass { title } to skip the prompt)',
    when: hasDocument,
    run: async (ctx) => {
      const service = nav(ctx);
      const document = doc(ctx);
      const given = ctx.args['title'];
      const title =
        typeof given === 'string'
          ? given
          : await service.dialogs.prompt({
              title: 'Add bookmark',
              label: 'Bookmark title',
              value: defaultBookmarkTitle(service),
            });
      if (title === null || title.trim() === '') return null;
      const selected = service.selectedBookmark;
      const at =
        selected === null
          ? {
              parentId: null,
              index: document.state.outline.filter((o) => o.parentId === null).length,
            }
          : nextTo(document, selected);
      const command = new AddBookmarkCommand(document, {
        title: title.trim(),
        at,
        destination: service.currentDestination(),
      });
      await document.apply(command);
      service.selectedBookmark = command.newId;
      return command.newId;
    },
  },
  {
    id: 'bookmarks.rename',
    label: 'Rename Bookmark…',
    category: 'View',
    icon: 'square-pen',
    when: hasDocument,
    run: async (ctx) => {
      const document = doc(ctx);
      const id = bookmarkOf(ctx);
      const current = document.outlineItem(id)?.title ?? '';
      const given = ctx.args['title'];
      const title =
        typeof given === 'string'
          ? given
          : await nav(ctx).dialogs.prompt({
              title: 'Rename bookmark',
              label: 'Bookmark title',
              value: current,
            });
      if (title === null || title.trim() === '' || title === current) return null;
      await document.apply(new RenameBookmarkCommand(document, id, title.trim()));
      document.breakMerge();
      return title.trim();
    },
  },
  {
    id: 'bookmarks.delete',
    label: 'Delete Bookmark',
    category: 'View',
    icon: 'trash-2',
    description: 'Delete the selected bookmark and everything under it',
    when: hasDocument,
    run: async (ctx) => {
      const document = doc(ctx);
      const id = bookmarkOf(ctx);
      await document.apply(new DeleteBookmarkCommand(document, id));
      nav(ctx).selectedBookmark = null;
      return true;
    },
  },
  {
    id: 'bookmarks.indent',
    label: 'Move Bookmark Right',
    category: 'View',
    icon: 'chevron-right',
    description: 'Nest the selected bookmark under the one above it',
    when: hasDocument,
    run: async (ctx) => await reshape(ctx, indent, 'Nest bookmark'),
  },
  {
    id: 'bookmarks.outdent',
    label: 'Move Bookmark Left',
    category: 'View',
    icon: 'chevron-left',
    description: 'Move the selected bookmark out one level',
    when: hasDocument,
    run: async (ctx) => await reshape(ctx, outdent, 'Un-nest bookmark'),
  },
  {
    id: 'bookmarks.moveUp',
    label: 'Move Bookmark Up',
    category: 'View',
    icon: 'chevron-up',
    when: hasDocument,
    run: async (ctx) => await slide(ctx, -1),
  },
  {
    id: 'bookmarks.moveDown',
    label: 'Move Bookmark Down',
    category: 'View',
    icon: 'chevron-down',
    when: hasDocument,
    run: async (ctx) => await slide(ctx, 1),
  },
  {
    id: 'bookmarks.setDestination',
    label: 'Set Bookmark Destination to This View',
    category: 'View',
    icon: 'crosshair',
    when: hasDocument,
    run: async (ctx) => {
      const document = doc(ctx);
      const id = bookmarkOf(ctx);
      const destination = nav(ctx).currentDestination();
      if (!destination) return false;
      await document.apply(new SetBookmarkTargetCommand(document, id, { destination }));
      return true;
    },
  },
  {
    id: 'bookmarks.setAction',
    label: 'Set Bookmark Action…',
    category: 'View',
    icon: 'link',
    description: 'Point the bookmark at a web address or a file instead of a page',
    when: hasDocument,
    run: async (ctx) => {
      const document = doc(ctx);
      const id = bookmarkOf(ctx);
      const item = document.outlineItem(id);
      const uri = await nav(ctx).dialogs.prompt({
        title: 'Bookmark action',
        label: 'Open this address when the bookmark is clicked',
        hint: 'Leave it empty to go back to a place in this document.',
        value: item?.uri ?? '',
      });
      if (uri === null) return null;
      const trimmed = uri.trim();
      if (trimmed === '') {
        const destination = nav(ctx).currentDestination();
        await document.apply(
          new SetBookmarkTargetCommand(document, id, {
            destination,
            label: 'Set bookmark destination',
          }),
        );
        return null;
      }
      await document.apply(
        new SetBookmarkTargetCommand(document, id, { uri: trimmed, destination: null }),
      );
      return trimmed;
    },
  },
  {
    id: 'bookmarks.toggleBold',
    label: 'Bold Bookmark',
    category: 'View',
    icon: 'baseline',
    when: hasDocument,
    run: async (ctx) => await style(ctx, 'bold'),
  },
  {
    id: 'bookmarks.toggleItalic',
    label: 'Italic Bookmark',
    category: 'View',
    icon: 'type',
    when: hasDocument,
    run: async (ctx) => await style(ctx, 'italic'),
  },
  {
    id: 'bookmarks.setColour',
    label: 'Bookmark Colour…',
    category: 'View',
    icon: 'pipette',
    description: 'Colour of the bookmark text in the file (pass { value } as #rrggbb, or empty)',
    when: hasDocument,
    run: async (ctx) => {
      const document = doc(ctx);
      const id = bookmarkOf(ctx);
      const raw = ctx.args['value'];
      const value =
        typeof raw === 'string'
          ? raw
          : await nav(ctx).dialogs.prompt({
              title: 'Bookmark colour',
              label: 'Colour as #rrggbb',
              hint: 'Leave it empty for the viewer’s own colour.',
              value: colourOf(document, id),
            });
      if (value === null) return null;
      const parsed = /^#?([0-9a-f]{6})$/i.exec(value.trim());
      const colour = parsed?.[1] === undefined ? null : Number.parseInt(parsed[1], 16);
      await document.apply(new SetBookmarkStyleCommand(document, id, { color: colour }));
      return colour;
    },
  },
  {
    id: 'bookmarks.expandTo',
    label: 'Expand Bookmarks to Level…',
    category: 'View',
    icon: 'list-tree',
    description: 'Open every bookmark down to a level (pass { level })',
    when: hasDocument,
    run: async (ctx) => {
      const document = doc(ctx);
      const raw = ctx.args['level'];
      const level =
        typeof raw === 'number'
          ? raw
          : Number(
              (await nav(ctx).dialogs.prompt({
                title: 'Expand bookmarks',
                label: `Levels to expand (1 to ${String(Math.max(1, maxDepth(document.state.outline) + 1))})`,
                value: '2',
              })) ?? '',
            );
      if (!Number.isFinite(level)) return null;
      // Expansion is view state: the panel reads `open`, and nothing is written to the file.
      document.setOutlineRecord(expandToLevel(document.state.outline, Math.max(0, level)));
      await nav(ctx).setSetting('expandBookmarksToLevel', Math.max(0, Math.min(6, level)));
      return level;
    },
  },
  {
    id: 'bookmarks.wrapTitles',
    label: 'Wrap Long Bookmark Titles',
    category: 'View',
    icon: 'text-cursor-input',
    when: hasNav,
    run: async (ctx) => {
      const service = nav(ctx);
      const next =
        typeof ctx.args['on'] === 'boolean' ? ctx.args['on'] : !service.settings.wrapBookmarkTitles;
      await service.setSetting('wrapBookmarkTitles', next);
      return next;
    },
  },
];

const LAYER_COMMANDS: ReadonlyArray<CommandSpec> = [
  {
    id: 'layers.toggle',
    label: 'Show or Hide Layer',
    category: 'View',
    icon: 'eye',
    description: 'Toggle one optional-content group (pass { layer } and optionally { visible })',
    when: hasDocument,
    run: async (ctx) => {
      const document = doc(ctx);
      const raw = ctx.args['layer'];
      const id =
        typeof raw === 'string' ? (raw as ModelId) : (document.state.layers[0]?.id ?? null);
      if (id === null) return null;
      const current = document.layer(id)?.visible ?? true;
      const visible = typeof ctx.args['visible'] === 'boolean' ? ctx.args['visible'] : !current;
      await document.apply(new SetLayerVisibleCommand(document, id, visible));
      const tab = nav(ctx).documents.active;
      if (tab) nav(ctx).invalidateRender(tab.id);
      return visible;
    },
  },
  {
    id: 'layers.reset',
    label: 'Reset Layers to Initial Visibility',
    category: 'View',
    icon: 'rotate-ccw',
    when: hasDocument,
    run: async (ctx) => {
      const service = nav(ctx);
      const document = doc(ctx);
      const tab = service.documents.active;
      const initial = tab ? service.initialLayerState.get(tab.id) : undefined;
      if (!initial) return 0;
      return await applyLayerState(service, document, initial, 'Reset layers');
    },
  },
  {
    id: 'layers.export',
    label: 'Export Layer Visibility…',
    category: 'View',
    icon: 'download',
    description: 'Write the current layer visibility to a JSON file',
    when: hasDocument,
    run: async (ctx) => {
      const document = doc(ctx);
      if (!hasBridge()) return null;
      const path = await invoke('file:saveAsDialog', {
        defaultPath: 'layers.json',
        title: 'Export layer visibility',
        buttonLabel: 'Export',
      });
      if (path === null) return null;
      const json = JSON.stringify(layerStateOf(document.state.layers), null, 2);
      await invoke('file:write', path, new TextEncoder().encode(json));
      return path;
    },
  },
  {
    id: 'layers.import',
    label: 'Import Layer Visibility…',
    category: 'View',
    icon: 'upload',
    description: 'Apply layer visibility from a JSON file, as a view or as the document default',
    when: hasDocument,
    run: async (ctx) => {
      const service = nav(ctx);
      const document = doc(ctx);
      if (!hasBridge()) return null;
      const [file] = await invoke('file:openFilesDialog', {
        title: 'Import layer visibility',
        buttonLabel: 'Import',
        multi: false,
        filters: [
          { name: 'Layer visibility', extensions: ['json'] },
          { name: 'All files', extensions: ['*'] },
        ],
      });
      if (!file) return null;
      const state = readLayerFile(file.bytes);
      if (!state) {
        await service.dialogs.error('Import layer visibility', `${file.name} is not a layer file.`);
        return null;
      }
      const choice = await service.dialogs.open({
        title: 'Import layer visibility',
        kind: 'question',
        content: el(
          'p',
          null,
          `Apply the visibility in ${file.name} to this view, or make it what the document ` +
            'saves as its own default?',
        ),
        buttons: [
          { id: 'cancel', label: 'Cancel' },
          { id: 'view', label: 'Apply to this view', primary: true },
          { id: 'default', label: 'Apply as default' },
        ],
      }).result;
      if (choice === 'cancel') return null;
      // Both paths run the same commands; "apply as default" is the one that is saved, and it
      // says so by being undoable in one step with a label that names it.
      const applied = await applyLayerState(
        service,
        document,
        state,
        choice === 'default' ? 'Set default layer visibility' : 'Show layers',
      );
      return applied;
    },
  },
];

const ATTACHMENT_COMMANDS: ReadonlyArray<CommandSpec> = [
  {
    id: 'attachments.open',
    label: 'Open Attachment',
    category: 'File',
    icon: 'external-link',
    description: 'Open the selected attachment — a PDF in a new tab, anything else in its own app',
    when: hasDocument,
    run: async (ctx) => await nav(ctx).openAttachment(attachmentOf(ctx)),
  },
  {
    id: 'attachments.saveAs',
    label: 'Save Attachment As…',
    category: 'File',
    icon: 'save',
    when: hasDocument,
    run: async (ctx) => await nav(ctx).saveAttachment(attachmentOf(ctx)),
  },
  {
    id: 'attachments.add',
    label: 'Attach Files…',
    category: 'File',
    icon: 'paperclip',
    description: 'Embed one or more files in this document',
    when: editableAttachments,
    run: async (ctx) => {
      const service = nav(ctx);
      const document = doc(ctx);
      const files = await service.chooseFiles();
      if (files.length === 0) return 0;
      const label =
        files.length === 1
          ? `Attach ${files[0]?.name ?? 'file'}`
          : `Attach ${String(files.length)} files`;
      await document.batch(label, async () => {
        for (const file of files) {
          await document.apply(new AddAttachmentCommand(document, file));
        }
      });
      return files.length;
    },
  },
  {
    id: 'attachments.delete',
    label: 'Delete Attachment',
    category: 'File',
    icon: 'trash-2',
    when: editableAttachments,
    run: async (ctx) => {
      const service = nav(ctx);
      const document = doc(ctx);
      const id = attachmentOf(ctx);
      const attachment = document.attachment(id);
      if (!attachment) return false;
      const ok =
        ctx.args['confirm'] === false ||
        (await service.dialogs.confirm({
          title: 'Delete attachment',
          text: `Delete ${attachment.name} from this document? It is only in the PDF.`,
          confirmLabel: 'Delete',
          danger: true,
        }));
      if (!ok) return false;
      await document.apply(new DeleteAttachmentCommand(document, id));
      service.selectedAttachment = null;
      return true;
    },
  },
  {
    id: 'attachments.describe',
    label: 'Edit Attachment Description…',
    category: 'File',
    icon: 'square-pen',
    when: editableAttachments,
    run: async (ctx) => {
      const document = doc(ctx);
      const id = attachmentOf(ctx);
      const attachment = document.attachment(id);
      if (!attachment) return null;
      const raw = ctx.args['description'];
      const description =
        typeof raw === 'string'
          ? raw
          : await nav(ctx).dialogs.prompt({
              title: `Describe ${attachment.name}`,
              label: 'Description',
              value: attachment.description ?? '',
            });
      if (description === null) return null;
      await document.apply(new DescribeAttachmentCommand(document, id, description));
      document.breakMerge();
      return description;
    },
  },
];

const DESTINATION_COMMANDS: ReadonlyArray<CommandSpec> = [
  {
    id: 'destinations.add',
    label: 'Create Destination from This View',
    category: 'View',
    icon: 'file-plus',
    when: hasDocument,
    run: async (ctx) => {
      const service = nav(ctx);
      const document = doc(ctx);
      const destination = service.currentDestination();
      if (!destination) return null;
      const raw = ctx.args['name'];
      const name =
        typeof raw === 'string'
          ? raw
          : await service.dialogs.prompt({
              title: 'Create destination',
              label: 'Destination name',
              hint: 'Other documents and links can point at this name.',
              value: suggestDestinationName(document),
            });
      if (name === null || name.trim() === '') return null;
      const command = new AddDestinationCommand(document, {
        name: name.trim(),
        destination,
      });
      await document.apply(command);
      service.selectedDestination = command.newId;
      return command.newId;
    },
  },
  {
    id: 'destinations.rename',
    label: 'Rename Destination…',
    category: 'View',
    icon: 'square-pen',
    when: hasDocument,
    run: async (ctx) => {
      const document = doc(ctx);
      const id = destinationOf(ctx);
      const current = document.destination(id)?.name ?? '';
      const raw = ctx.args['name'];
      const name =
        typeof raw === 'string'
          ? raw
          : await nav(ctx).dialogs.prompt({
              title: 'Rename destination',
              label: 'Destination name',
              value: current,
            });
      if (name === null || name.trim() === '' || name === current) return null;
      await document.apply(new RenameDestinationCommand(document, id, name.trim()));
      document.breakMerge();
      return name.trim();
    },
  },
  {
    id: 'destinations.setToView',
    label: 'Set Destination to This View',
    category: 'View',
    icon: 'crosshair',
    when: hasDocument,
    run: async (ctx) => {
      const document = doc(ctx);
      const id = destinationOf(ctx);
      const destination = nav(ctx).currentDestination();
      if (!destination) return false;
      await document.apply(new SetDestinationCommand(document, id, destination));
      return true;
    },
  },
  {
    id: 'destinations.delete',
    label: 'Delete Destination',
    category: 'View',
    icon: 'trash-2',
    when: hasDocument,
    run: async (ctx) => {
      const document = doc(ctx);
      const id = destinationOf(ctx);
      await document.apply(new DeleteDestinationCommand(document, id));
      nav(ctx).selectedDestination = null;
      return true;
    },
  },
];

/** Developer commands: how the e2e suite reads the panels out of the running app. */
const DEV_COMMANDS: ReadonlyArray<CommandSpec> = [
  {
    id: 'dev.navState',
    label: 'Navigation panel state',
    category: 'Developer',
    hidden: true,
    description: 'Internal: what the navigation panels are showing',
    when: hasNav,
    run: (ctx) => {
      const service = nav(ctx);
      const ui = service.ui.get();
      const panels = service.panels;
      const scroll = document.querySelector<HTMLElement>('[data-panel-scroll="pages"]');
      const cells = [...document.querySelectorAll<HTMLElement>('.thumb-cell')];
      const columns = new Set(cells.map((c) => c.style.left)).size;
      return {
        panel: panels?.active ?? null,
        collapsed: panels?.collapsed ?? true,
        paneWidth: ui.leftPane.width,
        thumbnailSize: service.settings.thumbnailSize,
        leftPaneOnOpen: service.settings.leftPaneOnOpen,
        thumbnails: {
          mounted: cells.length,
          columns: cells.length === 0 ? 0 : columns,
          rendered: cells.filter((c) => c.classList.contains('is-rendered')).length,
          current: cells.findIndex((c) => c.classList.contains('is-current')),
          scrollTop: scroll?.scrollTop ?? 0,
          labels: cells.map((c) => c.querySelector('.thumb-label')?.textContent ?? ''),
        },
        bookmarks: [...document.querySelectorAll<HTMLElement>('.nav-tree [data-row]')].map((r) => {
          const id = (r.dataset['id'] ?? '') as ModelId;
          const item = service.document?.outlineItem(id) ?? null;
          const dest =
            item?.destinationId == null
              ? null
              : (service.document?.destination(item.destinationId) ?? null);
          const page = dest?.pageId == null ? -1 : (service.document?.pageIndex(dest.pageId) ?? -1);
          return {
            id,
            title: r.querySelector('.nav-title')?.textContent ?? '',
            level: Number(r.getAttribute('aria-level') ?? '1'),
            expanded: r.getAttribute('aria-expanded'),
            current: r.classList.contains('is-current'),
            page,
            uri: item?.uri ?? null,
          };
        }),
        layers: [...document.querySelectorAll<HTMLElement>('.layer-row')].map((r) => ({
          id: r.dataset['id'] ?? '',
          name: r.querySelector('.nav-title')?.textContent ?? '',
          state: r.querySelector('.nav-state')?.textContent ?? '',
        })),
        attachments: [...document.querySelectorAll<HTMLElement>('.nav-table [data-row]')].map(
          (r) => ({
            id: r.dataset['id'] ?? '',
            cells: [...r.querySelectorAll('.nav-td')].map((c) => c.textContent ?? ''),
          }),
        ),
        destinations: [...document.querySelectorAll<HTMLElement>('.nav-list [data-row]')].map(
          (r) => ({
            id: r.dataset['id'] ?? '',
            name: r.querySelector('.nav-title')?.textContent ?? '',
            where: r.querySelector('.nav-page')?.textContent ?? '',
          }),
        ),
        portfolio:
          service.collection === null ? null : { fields: service.collection.fields.length },
        attachmentModel: (service.document?.state.attachments ?? []).map((a) => ({
          id: a.id,
          name: a.name,
          mimeType: a.mimeType,
          description: a.description,
        })),
        thumbnailStats: service.thumbnails.stats,
      };
    },
  },
  {
    id: 'dev.navSelect',
    label: 'Select in a navigation panel',
    category: 'Developer',
    hidden: true,
    description:
      'Internal: select a row by id (pass { bookmark } / { attachment } / { destination })',
    when: hasNav,
    run: (ctx) => {
      const service = nav(ctx);
      const pick = (key: 'bookmark' | 'attachment' | 'destination'): ModelId | null => {
        const value = ctx.args[key];
        return typeof value === 'string' ? (value as ModelId) : null;
      };
      if (ctx.args['bookmark'] !== undefined) service.selectedBookmark = pick('bookmark');
      if (ctx.args['attachment'] !== undefined) service.selectedAttachment = pick('attachment');
      if (ctx.args['destination'] !== undefined) service.selectedDestination = pick('destination');
      return {
        bookmark: service.selectedBookmark,
        attachment: service.selectedAttachment,
        destination: service.selectedDestination,
      };
    },
  },
  {
    id: 'dev.navAttach',
    label: 'Attach bytes',
    category: 'Developer',
    hidden: true,
    description: 'Internal: attach a file without the native dialog (pass { name, bytes })',
    when: hasDocument,
    run: async (ctx) => {
      const document = doc(ctx);
      const name = ctx.args['name'];
      const raw = ctx.args['bytes'];
      if (typeof name !== 'string' || !Array.isArray(raw)) {
        throw new Error('dev.navAttach needs { name, bytes }');
      }
      const description = ctx.args['description'];
      const command = new AddAttachmentCommand(document, {
        name,
        bytes: Uint8Array.from(raw as number[]),
        ...(typeof description === 'string' ? { description } : {}),
      });
      await document.apply(command);
      nav(ctx).selectedAttachment = command.newId;
      return command.newId;
    },
  },
  {
    id: 'dev.navPaneWidth',
    label: 'Set the navigation pane width',
    category: 'Developer',
    hidden: true,
    description: 'Internal: drag the splitter without a pointer (pass { width })',
    when: hasNav,
    run: (ctx) => {
      const width = ctx.args['width'];
      if (typeof width !== 'number') throw new Error('dev.navPaneWidth needs { width }');
      nav(ctx).setPaneWidth(width);
      return nav(ctx).ui.get().leftPane.width;
    },
  },
];

export default defineModule({
  id: 'M12',
  name: 'Navigation panels',
  settings: NAVIGATION_SETTINGS_SCHEMA,

  commands: [
    ...PANEL_COMMANDS,
    DEFAULT_PANEL_COMMAND,
    ...THUMBNAIL_COMMANDS,
    ...BOOKMARK_COMMANDS,
    ...LAYER_COMMANDS,
    ...ATTACHMENT_COMMANDS,
    ...DESTINATION_COMMANDS,
    ...DEV_COMMANDS,
  ],

  panels: [
    {
      id: PANEL_ID.pages,
      title: 'Pages',
      dock: 'left',
      icon: 'gallery-vertical',
      order: 10,
      toggleCommand: 'view.panel.pages',
      mount: (host, ctx) => mountPanel(host, ctx, mountThumbnailPanel),
    },
    {
      id: PANEL_ID.bookmarks,
      title: 'Bookmarks',
      dock: 'left',
      icon: 'bookmark',
      order: 20,
      toggleCommand: 'view.panel.bookmarks',
      mount: (host, ctx) => mountPanel(host, ctx, mountBookmarkPanel),
    },
    {
      id: PANEL_ID.layers,
      title: 'Layers',
      dock: 'left',
      icon: 'layers',
      order: 30,
      toggleCommand: 'view.panel.layers',
      mount: (host, ctx) => mountPanel(host, ctx, mountLayerPanel),
    },
    {
      id: PANEL_ID.attachments,
      title: 'Attachments',
      dock: 'left',
      icon: 'paperclip',
      order: 40,
      toggleCommand: 'view.panel.attachments',
      mount: (host, ctx) => mountPanel(host, ctx, mountAttachmentPanel),
    },
    {
      id: PANEL_ID.destinations,
      title: 'Destinations',
      dock: 'left',
      icon: 'tag',
      order: 50,
      toggleCommand: 'view.panel.destinations',
      mount: (host, ctx) => mountPanel(host, ctx, mountDestinationPanel),
    },
  ],

  ribbon: [
    {
      id: 'view.navigation',
      tab: 'view',
      label: 'Navigation panels',
      order: 10,
      items: [
        { kind: 'toggle', command: 'view.panel.pages', pressed: panelIs(PANEL_ID.pages) },
        { kind: 'toggle', command: 'view.panel.bookmarks', pressed: panelIs(PANEL_ID.bookmarks) },
        { kind: 'toggle', command: 'view.panel.layers', pressed: panelIs(PANEL_ID.layers) },
        {
          kind: 'toggle',
          command: 'view.panel.attachments',
          pressed: panelIs(PANEL_ID.attachments),
        },
        {
          kind: 'toggle',
          command: 'view.panel.destinations',
          pressed: panelIs(PANEL_ID.destinations),
        },
        '-',
        'view.thumbnails.smaller',
        'view.thumbnails.larger',
        {
          kind: 'dropdown',
          id: 'view.panel.defaults',
          label: 'Panel defaults',
          icon: 'panel-left',
          menu: () => [
            ...LEFT_PANE_ON_OPEN.map((option) => ({
              label: option.label,
              command: 'view.panel.defaultOnOpen',
              args: { value: option.value },
              checked: (ctx: ServiceContext): boolean =>
                hasNav(ctx) && nav(ctx).settings.leftPaneOnOpen === option.value,
            })),
            '-',
            { command: 'bookmarks.wrapTitles', checked: settingIs('wrapBookmarkTitles') },
          ],
        },
      ],
      large: ['view.panel.pages'],
    },
    {
      id: 'view.bookmarks',
      tab: 'view',
      label: 'Bookmarks',
      order: 12,
      when: hasDocument,
      items: [
        'bookmarks.add',
        'bookmarks.rename',
        'bookmarks.delete',
        '-',
        'bookmarks.indent',
        'bookmarks.outdent',
        'bookmarks.moveUp',
        'bookmarks.moveDown',
        '-',
        'bookmarks.setDestination',
        'bookmarks.setAction',
        {
          kind: 'dropdown',
          id: 'view.bookmarks.style',
          label: 'Bookmark style',
          icon: 'baseline',
          menu: ['bookmarks.toggleBold', 'bookmarks.toggleItalic', 'bookmarks.setColour'],
        },
        'bookmarks.expandTo',
      ],
      large: ['bookmarks.add'],
    },
    {
      id: 'view.attachments',
      tab: 'view',
      label: 'Attachments',
      order: 14,
      when: hasDocument,
      items: ['attachments.add', 'attachments.open', 'attachments.saveAs', 'attachments.delete'],
    },
  ],

  contextMenus: [
    {
      id: 'nav.paneStrip',
      // The tab strip down the side of the pane: where "open this panel by default" belongs.
      region: '.pane-strip',
      order: 10,
      items: [
        {
          label: 'Open this panel by default',
          submenu: LEFT_PANE_ON_OPEN.map((option) => ({
            label: option.label,
            command: 'view.panel.defaultOnOpen',
            args: { value: option.value },
            checked: (ctx: ServiceContext): boolean =>
              hasNav(ctx) && nav(ctx).settings.leftPaneOnOpen === option.value,
          })),
        },
      ],
    },
    {
      id: 'nav.bookmarkMenu',
      region: '.nav-tree',
      order: 10,
      items: [
        'bookmarks.add',
        'bookmarks.rename',
        'bookmarks.delete',
        '-',
        'bookmarks.indent',
        'bookmarks.outdent',
        '-',
        'bookmarks.setDestination',
        'bookmarks.setAction',
        'bookmarks.toggleBold',
        'bookmarks.toggleItalic',
        'bookmarks.setColour',
      ],
    },
    {
      id: 'nav.attachmentMenu',
      region: '.nav-table',
      order: 10,
      items: [
        'attachments.open',
        'attachments.saveAs',
        '-',
        'attachments.add',
        'attachments.describe',
        'attachments.delete',
      ],
    },
    {
      id: 'nav.destinationMenu',
      region: '[data-panel-scroll="destinations"]',
      order: 10,
      items: [
        'destinations.add',
        'destinations.rename',
        'destinations.setToView',
        'destinations.delete',
      ],
    },
    {
      id: 'nav.layerMenu',
      region: '[data-panel-scroll="layers"]',
      order: 10,
      items: ['layers.reset', 'layers.export', 'layers.import'],
    },
  ],

  activate(ctx) {
    const registry = ctx.service<Registry>('registry');
    if (registry.hasService(NAVIGATION_SERVICE)) return undefined;
    registerIcon('crosshair', Crosshair);
    registerNavigationCodecs();
    const shell = registry.service<ShellServices>('shellServices');
    const client = registry.service<EngineClient>('engineClient');
    const service = new NavigationService({ registry, shell, client });
    live = service;
    registry.provide(NAVIGATION_SERVICE, service);
    void service.load();
    return () => {
      live = null;
      service.dispose();
    };
  },
});

// ---- helpers ------------------------------------------------------------------------------------

/** Mounts a panel against the live service, or says so when the module has not activated. */
function mountPanel(
  host: HTMLElement,
  ctx: ServiceContext,
  mount: (host: HTMLElement, ctx: ServiceContext, service: NavigationService) => () => void,
): () => void {
  const service = live;
  if (!service) {
    host.append(el('p.nav-empty', null, 'The navigation panels are not available.'));
    return () => {
      host.replaceChildren();
    };
  }
  return mount(host, ctx, service);
}

function panelIs(id: string): (ctx: ServiceContext) => boolean {
  return (ctx) => ctx.service<PanelsService>(SERVICE.panels).active === id;
}

function settingIs(name: 'wrapBookmarkTitles'): (ctx: ServiceContext) => boolean {
  return (ctx) => hasNav(ctx) && nav(ctx).settings[name];
}

/** Where a new bookmark goes: right after the selected one, as a sibling. */
function nextTo(
  document: Document,
  selected: ModelId,
): { parentId: ModelId | null; index: number } {
  const at = positionOf(document.state.outline, selected);
  return at === null
    ? { parentId: null, index: document.state.outline.length }
    : { parentId: at.parentId, index: at.index + 1 };
}

/** A first suggestion for a bookmark title: the page it will point at. */
function defaultBookmarkTitle(service: NavigationService): string {
  const document = service.document;
  const page = document?.state.pages[service.currentPage];
  return page ? `Page ${page.label}` : 'Bookmark';
}

/** A first suggestion for a destination name, unique in the document. */
function suggestDestinationName(document: Document): string {
  const taken = new Set(document.state.destinations.map((d) => d.name));
  for (let i = 1; i < 1000; i++) {
    const name = `destination-${String(i)}`;
    if (!taken.has(name)) return name;
  }
  return 'destination';
}

function colourOf(document: Document, id: ModelId): string {
  const colour = document.outlineItem(id)?.color;
  return colour === null || colour === undefined ? '' : `#${colour.toString(16).padStart(6, '0')}`;
}

/** Indent / outdent, as a move command so it undoes like every other shape change. */
async function reshape(
  ctx: ServiceContext & { args?: Readonly<Record<string, unknown>> },
  shape: (list: Parameters<typeof indent>[0], id: ModelId) => ReturnType<typeof indent>,
  label: string,
): Promise<boolean> {
  const document = doc(ctx);
  const id = bookmarkOf(ctx);
  const after = shape(document.state.outline, id);
  const to = positionOf(after, id);
  if (!to) return false;
  const before = positionOf(document.state.outline, id);
  if (before?.parentId === to.parentId && before.index === to.index) return false;
  await document.apply(new MoveBookmarkCommand(document, id, to, label));
  return true;
}

/** A layer-visibility file, or null when it is not one. */
function readLayerFile(bytes: Uint8Array): LayerState | null {
  try {
    return parseLayerState(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
  } catch {
    return null;
  }
}

/** Move up / down among siblings. */
async function slide(
  ctx: ServiceContext & { args?: Readonly<Record<string, unknown>> },
  direction: 1 | -1,
): Promise<boolean> {
  const document = doc(ctx);
  const id = bookmarkOf(ctx);
  const at = positionOf(document.state.outline, id);
  if (!at) return false;
  const siblings =
    at.parentId === null
      ? document.state.outline.filter((o) => o.parentId === null).length
      : (document.outlineItem(at.parentId)?.childIds.length ?? 0);
  const index = at.index + direction;
  if (index < 0 || index >= siblings) return false;
  await document.apply(
    new MoveBookmarkCommand(
      document,
      id,
      { parentId: at.parentId, index },
      direction < 0 ? 'Move bookmark up' : 'Move bookmark down',
    ),
  );
  return true;
}

/** Bold / italic toggles, as one style command. */
async function style(
  ctx: ServiceContext & { args?: Readonly<Record<string, unknown>> },
  which: 'bold' | 'italic',
): Promise<boolean> {
  const document = doc(ctx);
  const id = bookmarkOf(ctx);
  const item = document.outlineItem(id);
  if (!item) return false;
  const next = typeof ctx.args?.['on'] === 'boolean' ? ctx.args['on'] : !item[which];
  await document.apply(new SetBookmarkStyleCommand(document, id, { [which]: next }));
  return next;
}

/**
 * Applies a whole visibility set as one undo entry, matching layers by name — which is what a
 * file written against another copy of the document can be matched on.
 */
async function applyLayerState(
  service: NavigationService,
  document: Document,
  state: LayerState,
  label: string,
): Promise<number> {
  const changes = document.state.layers.filter(
    (layer) => layer.name in state && state[layer.name] !== layer.visible,
  );
  if (changes.length === 0) return 0;
  await document.batch(label, async () => {
    for (const layer of changes) {
      await document.apply(
        new SetLayerVisibleCommand(document, layer.id, state[layer.name] ?? layer.visible),
      );
    }
  });
  const tab = service.documents.active;
  if (tab) service.invalidateRender(tab.id);
  return changes.length;
}
