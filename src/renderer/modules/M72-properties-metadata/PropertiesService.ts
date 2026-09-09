/**
 * `PropertiesService` (M72) — the Document Properties dialog, and doing what a document asks for
 * when it is opened.
 *
 * Two jobs, one service because they share the same state: the dialog reads and writes the
 * model's metadata and view settings, and the open-time applier reads the same view settings and
 * turns them into calls on M11's viewer. Registered as the service `"properties"`.
 */

import type { Registry } from '@core/Registry';
import type { Document } from '@core/Document';
import type { ShellServices } from '@app/services';
import { SERVICE } from '@app/services';
import type { PanelsService } from '@app/panes/NavPane';
import type { DocumentTab } from '@app/tabs/Documents';
import type { FontUsage } from '@engine/PdfEngine';
import { el } from '@app/dom';
import { pageSizeOf, type ModelPage } from '@core/model';
import {
  DOCUMENT_SERVICE,
  type DocumentService,
} from '@modules/M20-document-model/DocumentService';
import {
  securityPropertiesPanel,
  SECURITY_SERVICE,
  type SecurityService,
} from '@modules/M70-encryption/manifest';
import { PAGE_SIZE_PRESETS } from '@shared/pageSizes';
import { hasBridge, invoke } from '@shared/ipc';
import { SetInitialViewCommand, SetPropertiesCommand } from './commands';
import { openPropertiesDialog, type PropertiesFacts, type PropertiesTabId } from './dialog';
import {
  propertiesPatch,
  readInitialView,
  readProperties,
  viewPatch,
  type DocumentProperties,
  type InitialViewSettings,
} from './properties';
import { applyInitialView, type AppliedView, type ViewTarget } from './apply';
import {
  DEFAULT_PROPERTIES_SETTINGS,
  ipcSettingsStorage,
  readPropertiesSettings,
  type PropertiesSettings,
  type SettingsStorage,
} from './settings';

export const PROPERTIES_SERVICE = 'properties';

export interface PropertiesServiceOptions {
  readonly registry: Registry;
  readonly shell: ShellServices;
  readonly storage?: SettingsStorage;
}

/** What M11 gives back for a tab. Structural, so nothing here imports the viewer's class. */
interface ViewerLike extends ViewTarget {
  readonly document: Document;
}

export class PropertiesService {
  private readonly registry: Registry;
  private readonly shell: ShellServices;
  private readonly storage: SettingsStorage;
  private settingsValue: PropertiesSettings = DEFAULT_PROPERTIES_SETTINGS;
  private readonly disposers: Array<() => void> = [];
  /** Fonts by document id, read once and kept: a document's fonts do not change as it is read. */
  private readonly fontCache = new Map<string, ReadonlyArray<FontUsage> | 'unavailable'>();
  /** What the last applied initial view did, by document id — the e2e suite asks for it. */
  private readonly applied = new Map<string, AppliedView>();

  constructor(options: PropertiesServiceOptions) {
    this.registry = options.registry;
    this.shell = options.shell;
    this.storage = options.storage ?? ipcSettingsStorage();
  }

  get settings(): PropertiesSettings {
    return this.settingsValue;
  }

  private get documents(): DocumentService {
    return this.registry.service<DocumentService>(DOCUMENT_SERVICE);
  }

  private get panels(): PanelsService | null {
    return this.registry.hasService(SERVICE.panels)
      ? this.registry.service<PanelsService>(SERVICE.panels)
      : null;
  }

  /** Reads the settings and starts watching for documents to open. Called once from `activate`. */
  async load(): Promise<void> {
    this.settingsValue = await readPropertiesSettings(this.storage);
    this.disposers.push(
      this.shell.documents.onAttached((tab, value) => {
        // Two things attach to a tab: M20's `Document`, then M11's viewer. The viewer is the one
        // that can be told where to go, so that is the signal this waits for.
        if (isViewer(value)) this.onViewerAttached(tab, value);
      }),
    );
  }

  dispose(): void {
    for (const stop of this.disposers.splice(0)) stop();
    this.fontCache.clear();
    this.applied.clear();
  }

  /** What applying a document's initial view did, for the developer command and the e2e suite. */
  appliedView(document: Document): AppliedView | null {
    return this.applied.get(document.id) ?? null;
  }

  /** The navigation panel that is open, so a test can see what a document's page mode did. */
  activePanel(): string | null {
    const panels = this.panels;
    return panels && !panels.collapsed ? panels.active : null;
  }

  private onViewerAttached(tab: DocumentTab, viewer: ViewerLike): void {
    const document = viewer.document;
    const view = document.state.view;
    const page =
      view.initialPageId === null
        ? null
        : document.state.pages.findIndex((p) => p.id === view.initialPageId);
    const result = applyInitialView({
      view,
      settings: this.settingsValue,
      viewer,
      panels: this.panels,
      page: page === null || page < 0 ? null : page,
    });
    this.applied.set(document.id, result);
    if (this.settingsValue.applyWindowOptions) this.applyWindowOptions(view);
    if (this.settingsValue.applyDisplayDocTitle && view.displayDocTitle) {
      const title = document.state.metadata.title;
      if (title && title.trim() !== '') this.shell.documents.update(tab.id, { title });
    }
  }

  /**
   * The file's request to hide parts of the application, when the reader has allowed it.
   *
   * Off by default, and deliberately: a PDF that hides the ribbon has taken the application away
   * from the person using it, and most files that set these flags were made by a tool that set
   * them without being asked. What ynotPDF does obey is the *storing* of them — the flags are
   * written back exactly as they were set, whatever this application does about them.
   */
  private applyWindowOptions(view: Document['state']['view']): void {
    const ui = this.shell.ui;
    if (view.hideToolbar || view.hideWindowUi) {
      ui.set((s) => ({ ribbon: { ...s.ribbon, minimised: true } }));
    }
    if (view.hideWindowUi) this.panels?.collapse();
  }

  /** The fonts of a document, read once. `'unavailable'` when the engine cannot list them. */
  async fontsOf(document: Document): Promise<ReadonlyArray<FontUsage> | 'unavailable'> {
    const cached = this.fontCache.get(document.id);
    if (cached) return cached;
    const fonts = await document.engine
      .fonts(document.handle)
      .catch((): 'unavailable' => 'unavailable');
    this.fontCache.set(document.id, fonts);
    return fonts;
  }

  /**
   * Opens the dialog and applies what the reader changed.
   *
   * The properties and the initial view are two commands rather than one, because they are two
   * different write intents and undoing "I changed the title" should not also undo "I set it to
   * open on page 3". Both are applied in one turn, so one press of OK is one visible change.
   */
  async showProperties(
    document: Document,
    options: { readonly tab?: PropertiesTabId } = {},
  ): Promise<{ properties: boolean; view: boolean }> {
    const before = readProperties(document);
    const beforeView = readInitialView(document);
    const readOnly = !document.state.security.permissions.modify;
    const answer = await openPropertiesDialog(this.shell.dialogs, {
      properties: before,
      view: beforeView,
      facts: await this.factsOf(document),
      pages: document.state.pages.map((p) => ({ id: p.id, label: p.label })),
      fonts: await this.fontsOf(document),
      security: this.securityPanel(document),
      ...(this.registry.has('protect.security')
        ? {
            onProtect: () => {
              void this.shell.run('protect.security');
            },
          }
        : {}),
      ...(this.registry.has('view.panel.signatures')
        ? {
            onShowSignatures: () => {
              void this.shell.run('view.panel.signatures');
            },
          }
        : {}),
      ...(options.tab ? { tab: options.tab } : {}),
      readOnly,
    });
    if (!answer || readOnly) return { properties: false, view: false };
    return this.apply(document, before, beforeView, answer.properties, answer.view);
  }

  /** Applies the dialog's answer. Separated so the developer command can drive it directly. */
  async apply(
    document: Document,
    before: DocumentProperties,
    beforeView: InitialViewSettings,
    properties: DocumentProperties,
    view: InitialViewSettings,
  ): Promise<{ properties: boolean; view: boolean }> {
    const patch = propertiesPatch(before, properties);
    const viewChange = viewPatch(beforeView, view);
    if (patch) await document.apply(new SetPropertiesCommand(document, patch));
    if (viewChange) await document.apply(new SetInitialViewCommand(document, viewChange));
    return { properties: patch !== null, view: viewChange !== null };
  }

  /**
   * The Security tab's content.
   *
   * M70 exports the panel it already draws in its own Security Properties dialog, for exactly
   * this — so the two places a reader can look at a document's protection say the same words. A
   * build without M70 gets what the file itself reports, which is all the model knows.
   */
  private securityPanel(document: Document): HTMLElement {
    if (this.registry.hasService(SECURITY_SERVICE)) {
      const security = this.registry.service<SecurityService>(SECURITY_SERVICE);
      const state = security.securityOf(document);
      return securityPropertiesPanel({
        info: state.info,
        intent: state.intent,
        openedAs: state.openedAs,
        pending: state.intent.kind !== 'none',
      });
    }
    const security = document.state.security;
    const panel = el('div.properties-panel');
    panel.append(
      el(
        'p.properties-lead',
        null,
        security.encrypted
          ? 'This document is protected with a password. This build cannot say more about it.'
          : 'This document is not protected: anyone who has the file can open, print and copy from it.',
      ),
    );
    return panel;
  }

  /** Everything the dialog shows and cannot change. */
  private async factsOf(document: Document): Promise<PropertiesFacts> {
    const state = document.state;
    const meta = state.metadata;
    const first = state.pages[0];
    return {
      fileName: fileNameOf(state.path, state.title),
      path: state.path,
      fileSize: await this.fileSizeOf(state.path),
      pageCount: state.pages.length,
      pageSize: first ? describePageSize(first) : 'No pages',
      version: meta.version,
      created: formatDate(meta.created),
      modified: formatDate(meta.modified),
      tagged: meta.tagged,
      linearized: meta.linearized,
      hasForm: meta.hasForm,
      hasXfa: meta.hasXfa,
      xmp: meta.xmp,
      signatureCount: state.signatures.length,
    };
  }

  /** The size of the file on disk, or null when it has never been saved or cannot be read. */
  private async fileSizeOf(path: string | null): Promise<number | null> {
    if (path === null || !hasBridge()) return null;
    const probe = await invoke('file:probe', path).catch(() => null);
    return probe?.exists === true ? probe.size : null;
  }
}

function isViewer(value: unknown): value is ViewerLike {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Partial<ViewerLike>;
  return (
    typeof v.goToPage === 'function' &&
    typeof v.setLayout === 'function' &&
    typeof v.setZoom === 'function' &&
    v.document !== undefined
  );
}

function fileNameOf(path: string | null, title: string): string {
  if (path === null) return `${title} (not saved yet)`;
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/** "210 x 297 mm (A4)", or just the millimetres when the size has no name we know. */
export function describePageSize(page: ModelPage): string {
  const size = pageSizeOf(page);
  const widthMm = size.width * MM_PER_POINT;
  const heightMm = size.height * MM_PER_POINT;
  const measured = `${widthMm.toFixed(0)} × ${heightMm.toFixed(0)} mm`;
  const named = namedSize(widthMm, heightMm);
  return named === null ? measured : `${measured} (${named})`;
}

const MM_PER_POINT = 25.4 / 72;

/**
 * The preset a page matches, either way up, within a millimetre.
 *
 * A millimetre rather than an exact match because A4 is 595.276 points and half the world's
 * files round that to 595 — a reader who is told "209 x 297 mm" when they are looking at A4 has
 * been told something useless.
 */
function namedSize(widthMm: number, heightMm: number): string | null {
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1;
  for (const preset of PAGE_SIZE_PRESETS) {
    if (near(widthMm, preset.widthMm) && near(heightMm, preset.heightMm)) return preset.label;
    if (near(widthMm, preset.heightMm) && near(heightMm, preset.widthMm)) {
      return `${preset.label}, landscape`;
    }
  }
  return null;
}

/** A date in the reader's locale, en-GB by default (PLAN §9). Null when the file has none. */
export function formatDate(iso: string | null): string | null {
  if (iso === null) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(date);
}
