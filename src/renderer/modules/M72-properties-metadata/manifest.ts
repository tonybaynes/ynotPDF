/**
 * M72 manifest — document properties, metadata and XMP, initial view.
 *
 * What the reader can reach: the Properties command (`Ctrl+D`, and the File backstage's
 * Properties slot, which nothing had filled), a shortcut straight to each tab from the command
 * palette, and the developer commands the e2e suite drives.
 *
 * The service does the work; this file is what the shell needs to know about it.
 */

import type { ShellServices } from '@app/services';
import { registerIcon } from '@app/icons';
import { el } from '@app/dom';
import { Eye, FileCog, FileText, List, Type } from 'lucide';
import type { Document } from '@core/Document';
import type { Registry } from '@core/Registry';
import {
  DOCUMENT_SERVICE,
  type DocumentService,
} from '@modules/M20-document-model/DocumentService';
import { defineModule, type ServiceContext } from '@shared/module';
import { registerPropertiesCodecs } from './commands';
import { readInitialView, readProperties } from './properties';
import { PropertiesService, PROPERTIES_SERVICE } from './PropertiesService';
import { PROPERTIES_SETTINGS_SCHEMA } from './settings';
import type { PropertiesTabId } from './dialog';

export { PropertiesService, PROPERTIES_SERVICE } from './PropertiesService';
export type { PropertiesTabId } from './dialog';

/**
 * Icons the shell does not already carry, registered as this file loads rather than in
 * `activate`: the ribbon is built from the manifest before any module is activated, and an icon
 * registered later would already have been drawn as a placeholder (M70 does the same).
 */
registerIcon('file-cog', FileCog);
registerIcon('file-text', FileText);
registerIcon('list', List);
registerIcon('type', Type);
registerIcon('eye', Eye);

const properties = (ctx: ServiceContext): PropertiesService =>
  ctx.service<PropertiesService>(PROPERTIES_SERVICE);

const hasService = (ctx: ServiceContext): boolean =>
  ctx.service<Registry>('registry').hasService(PROPERTIES_SERVICE);

const hasDocument = (ctx: ServiceContext): boolean =>
  hasService(ctx) && ctx.service<DocumentService>(DOCUMENT_SERVICE).active !== null;

function activeDocument(ctx: ServiceContext): Document {
  const doc = ctx.service<DocumentService>(DOCUMENT_SERVICE).active;
  if (!doc) throw new Error('No document is open');
  return doc;
}

/** A tab id from command arguments, or undefined so the dialog opens where it always does. */
function tabArg(value: unknown): PropertiesTabId | undefined {
  const tabs: ReadonlyArray<PropertiesTabId> = [
    'description',
    'custom',
    'security',
    'fonts',
    'initialView',
    'advanced',
  ];
  return typeof value === 'string' && (tabs as ReadonlyArray<string>).includes(value)
    ? (value as PropertiesTabId)
    : undefined;
}

export default defineModule({
  id: 'M72',
  name: 'Document properties',

  activate(ctx) {
    const registry = ctx.service<Registry>('registry');
    if (registry.hasService(PROPERTIES_SERVICE)) return undefined;
    if (!registry.hasService('shellServices') || !registry.hasService(DOCUMENT_SERVICE)) {
      return undefined;
    }
    registerPropertiesCodecs();
    const shell = registry.service<ShellServices>('shellServices');
    const service = new PropertiesService({ registry, shell });
    registry.provide(PROPERTIES_SERVICE, service);
    void service.load();
    return () => {
      service.dispose();
    };
  },

  settings: PROPERTIES_SETTINGS_SCHEMA,

  commands: [
    {
      id: 'file.properties',
      label: 'Document Properties…',
      category: 'File',
      icon: 'file-cog',
      shortcut: 'Mod+D',
      description:
        'Title, author, keywords, custom properties, security, fonts, initial view and advanced settings',
      when: hasDocument,
      run: async (ctx) => {
        const tab = tabArg(ctx.args['tab']);
        return properties(ctx).showProperties(activeDocument(ctx), tab ? { tab } : {});
      },
    },
    {
      id: 'file.properties.fonts',
      label: 'Document Properties: Fonts',
      category: 'File',
      icon: 'type',
      description: 'Which fonts this document uses, and whether they are embedded',
      when: hasDocument,
      run: (ctx) => properties(ctx).showProperties(activeDocument(ctx), { tab: 'fonts' }),
    },
    {
      id: 'file.properties.initialView',
      label: 'Document Properties: Initial View',
      category: 'File',
      icon: 'eye',
      description: 'How this document asks to be opened: page, magnification, layout, panel',
      when: hasDocument,
      run: (ctx) => properties(ctx).showProperties(activeDocument(ctx), { tab: 'initialView' }),
    },
    {
      id: 'file.properties.custom',
      label: 'Document Properties: Custom Properties',
      category: 'File',
      icon: 'list',
      description: 'Properties of your own, stored in the document and mirrored in its XMP',
      when: hasDocument,
      run: (ctx) => properties(ctx).showProperties(activeDocument(ctx), { tab: 'custom' }),
    },

    // ---- developer commands: how the e2e suite drives the dialog -------------------------------
    {
      id: 'dev.properties',
      label: 'Properties: report what the document says',
      category: 'Developer',
      icon: 'file-cog',
      description: 'The metadata, the initial view, the fonts and what opening the file applied',
      when: hasDocument,
      run: async (ctx) => {
        const doc = activeDocument(ctx);
        const service = properties(ctx);
        const fonts = await service.fontsOf(doc);
        return {
          metadata: doc.state.metadata,
          view: doc.state.view,
          fonts: fonts === 'unavailable' ? 'unavailable' : fonts,
          applied: service.appliedView(doc),
          writeIntents: doc.state.writeIntents,
          panel: service.activePanel(),
        };
      },
    },
    {
      id: 'dev.setProperties',
      label: 'Properties: change them without the dialog',
      category: 'Developer',
      icon: 'file-cog',
      description: 'Applies { properties, view } patches — the e2e suite uses this',
      when: hasDocument,
      run: async (ctx) => {
        const doc = activeDocument(ctx);
        const service = properties(ctx);
        const before = readProperties(doc);
        const beforeView = readInitialView(doc);
        const patch = (ctx.args['properties'] ?? {}) as Record<string, unknown>;
        const viewPatchArgs = (ctx.args['view'] ?? {}) as Record<string, unknown>;
        return service.apply(
          doc,
          before,
          beforeView,
          { ...before, ...patch },
          { ...beforeView, ...viewPatchArgs },
        );
      },
    },
  ],

  ribbon: [
    {
      id: 'view.document',
      tab: 'view',
      label: 'Document',
      order: 90,
      items: [{ kind: 'button', command: 'file.properties', size: 'large' }],
      when: hasDocument,
    },
    {
      id: 'protect.metadata',
      tab: 'protect',
      label: 'Metadata',
      order: 60,
      items: [
        { kind: 'button', command: 'file.properties', size: 'large' },
        'file.properties.custom',
      ],
      when: hasDocument,
    },
  ],

  backstage: [
    {
      slot: 'properties',
      // A page rather than a command, because the backstage is where a reader looks for facts
      // about the file and a dialog on top of it would be a window on top of a window.
      mount: (host, ctx) => {
        const summary = el('div.properties-backstage', { id: 'properties-backstage' });
        const open = (): void => {
          void ctx.run('file.properties');
        };
        if (!hasDocument(ctx)) {
          summary.append(
            el('p.properties-lead', null, 'Open a document to see and change its properties.'),
          );
        } else {
          const doc = activeDocument(ctx);
          const meta = doc.state.metadata;
          summary.append(
            el('h3.properties-heading', null, meta.title ?? doc.state.title),
            el(
              'p.properties-lead',
              null,
              `${String(doc.state.pages.length)} ${doc.state.pages.length === 1 ? 'page' : 'pages'}, PDF ${meta.version}`,
            ),
          );
          const openButton = el(
            'button.btn',
            { type: 'button', id: 'properties-backstage-open' },
            'Open Document Properties…',
          );
          openButton.addEventListener('click', open);
          summary.append(openButton);
        }
        host.append(summary);
        return () => {
          summary.remove();
        };
      },
    },
  ],

  contextMenus: [
    {
      id: 'properties.document',
      region: 'document',
      order: 90,
      items: ['-', 'file.properties'],
      when: hasDocument,
    },
  ],
});
