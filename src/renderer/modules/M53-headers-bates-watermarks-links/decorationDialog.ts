/**
 * The shared page-decoration dialog (M53).
 *
 * Four dialogs — header and footer, Bates, watermark, background — are the same dialog with a
 * different middle: settings on the left, a **live preview of a real page** on the right, a page
 * range under it, and a preset row across the top. Written once because the alternative is four
 * page-range fields that disagree about what `2-4, even` means.
 *
 * The preview is not a drawing of what the page might look like. It is the page: the chosen page
 * is imported into a scratch document in the engine, the decoration is applied to it with the
 * same call the real thing uses, and the engine renders it. What the reader sees is what the
 * file will contain.
 */

import { field } from '@app/dialog/Dialogs';
import type { ShellServices } from '@app/services';
import { el } from '@app/dom';
import type { Document } from '@core/Document';
import type { DocHandle } from '@engine/PdfEngine';
import type { PlannedDecoration, PlannedXObject } from '@engine/Writer';
import type { DecorationKind, DecorationSpec } from '@engine/decorations/types';
import { drawDecoration } from '@engine/decorations/draw';
import { XOBJECTS_NAMESPACE } from '@modules/M21-save/plan';
import { rangeField, type RangeField } from '@modules/M41-merge-split-crop/fields';
import type { RangeContext } from '@modules/M40-organise-pages/range';
import type { Unit } from '@view/units';
import { documentContext, pageContextFor, sourceSizes, sourcesUsed } from './model';
import {
  builtInFor,
  presetId,
  presetsToJson,
  readCustomPresets,
  withPreset,
  type DecorationPreset,
} from './presets';

/** How long after the last keystroke the preview is redrawn. */
const PREVIEW_DEBOUNCE_MS = 180;

export interface DecorationDialogOptions<S extends DecorationSpec> {
  readonly shell: ShellServices;
  readonly document: Document;
  readonly kind: DecorationKind;
  readonly title: string;
  /** Dialog element id, so a journey can find it by name. */
  readonly id: string;
  /** The settings to open on. */
  readonly spec: S;
  /** The page range to open on. */
  readonly range: string;
  /** Whether the document already has one of these, so the buttons say Update rather than Add. */
  readonly existing: boolean;
  readonly units: Unit;
  /** Builds the settings column. `onChange` re-draws the preview. */
  build(context: DecorationFormContext<S>): void;
  /** The current settings, read out of the form. */
  read(): S;
  /** The reader's saved presets, and how to store them. */
  readonly presets: string;
  savePresets(json: string): Promise<void>;
  /** Applies a preset's settings to the form. */
  applyPreset(spec: S): void;
}

export interface DecorationFormContext<S extends DecorationSpec> {
  /** Where the settings controls go. */
  readonly body: HTMLElement;
  /** Call after any change, to redraw the preview. */
  readonly changed: () => void;
  readonly units: Unit;
  readonly spec: S;
}

export type DecorationDialogResult<S extends DecorationSpec> =
  | {
      readonly action: 'apply';
      readonly spec: S;
      readonly pages: ReadonlyArray<number>;
      readonly range: string;
    }
  | { readonly action: 'remove' }
  | { readonly action: 'cancel' };

/** Opens the dialog and resolves with what the reader chose. */
export async function openDecorationDialog<S extends DecorationSpec>(
  options: DecorationDialogOptions<S>,
): Promise<DecorationDialogResult<S>> {
  const doc = options.document;
  const rangeContext: RangeContext = {
    pageCount: doc.state.pages.length,
    currentPage: 0,
    selectedPages: [],
    pageSizes: doc.state.pages.map((p) => {
      const box = p.cropBox ?? p.mediaBox;
      const w = box.x1 - box.x0;
      const h = box.y1 - box.y0;
      const swap = p.rotation === 90 || p.rotation === 270;
      return { width: swap ? h : w, height: swap ? w : h };
    }),
  };

  let rangeInput: RangeField | undefined;
  const preview = new DecorationPreview(doc, options.kind);
  let custom = readCustomPresets(options.presets);

  const presetSelect = el('select.input', { 'data-testid': 'decoration-presets' });
  const repaintPresets = (): void => {
    presetSelect.replaceChildren();
    presetSelect.append(el('option', { value: '' }, 'Choose a preset…'));
    for (const preset of [
      ...builtInFor(options.kind),
      ...custom.filter((p) => p.kind === options.kind),
    ]) {
      presetSelect.append(
        el('option', { value: preset.id }, preset.custom ? `${preset.name} (yours)` : preset.name),
      );
    }
  };
  repaintPresets();

  const dialog = options.shell.dialogs.open({
    id: options.id,
    title: options.title,
    width: 880,
    className: 'decoration-dialog',
    content: (body) => {
      const columns = el('div.decoration-columns');
      const settings = el('div.decoration-settings');
      const previewColumn = el('div.decoration-preview-column');

      const changed = (): void => {
        preview.request(currentSpec(), rangeInput?.pages() ?? null);
      };

      // Presets across the top of the settings column.
      const presetRow = el('div.decoration-preset-row');
      const saveButton = el('button.btn', { type: 'button' }, 'Save as preset');
      const deleteButton = el('button.btn', { type: 'button' }, 'Delete preset');
      deleteButton.disabled = true;
      presetRow.append(
        field({ label: 'Preset', input: presetSelect }),
        el('div.decoration-preset-actions', null, saveButton, deleteButton),
      );
      settings.append(presetRow);

      options.build({ body: settings, changed, units: options.units, spec: options.spec });

      const built = rangeField({ label: 'Pages', value: options.range, context: rangeContext });
      built.onChange(changed);
      settings.append(built.element);
      rangeInput = built;

      previewColumn.append(
        el('h3.decoration-preview-title', null, 'Preview'),
        preview.element,
        preview.controls,
      );
      columns.append(settings, previewColumn);
      body.append(columns);

      presetSelect.addEventListener('change', () => {
        const chosen = [...builtInFor(options.kind), ...custom].find(
          (p) => p.id === presetSelect.value,
        );
        deleteButton.disabled = !chosen?.custom;
        if (!chosen) return;
        options.applyPreset(chosen.spec as S);
        changed();
      });

      saveButton.addEventListener('click', () => {
        void (async () => {
          const name = await options.shell.dialogs.prompt({
            title: 'Save as preset',
            label: 'Name',
            value: '',
          });
          if (name === null || name.trim() === '') return;
          const preset: DecorationPreset = {
            id: presetId(name.trim(), custom),
            name: name.trim(),
            kind: options.kind,
            spec: currentSpec(),
            custom: true,
          };
          custom = withPreset(custom, preset);
          await options.savePresets(presetsToJson(custom));
          repaintPresets();
          presetSelect.value = preset.id;
          deleteButton.disabled = false;
          options.shell.toasts.show({ kind: 'success', text: `Saved the preset "${preset.name}"` });
        })();
      });

      deleteButton.addEventListener('click', () => {
        void (async () => {
          const id = presetSelect.value;
          const preset = custom.find((p) => p.id === id);
          if (!preset) return;
          custom = custom.filter((p) => p.id !== id);
          await options.savePresets(presetsToJson(custom));
          repaintPresets();
          deleteButton.disabled = true;
          options.shell.toasts.show({ kind: 'info', text: `Deleted the preset "${preset.name}"` });
        })();
      });

      preview.onPageChange(changed);
      changed();
    },
    buttons: [
      { id: 'apply', label: options.existing ? 'Update' : 'Add', primary: true },
      ...(options.existing ? [{ id: 'remove', label: 'Remove', danger: true }] : []),
      { id: 'cancel', label: 'Cancel' },
    ],
  });

  const currentSpec = (): S => options.read();

  const result = await dialog.result;
  preview.dispose();
  if (result === 'remove') return { action: 'remove' };
  if (result !== 'apply') return { action: 'cancel' };
  const pages = rangeInput?.pages() ?? null;
  if (!pages || pages.length === 0) {
    options.shell.toasts.show({
      kind: 'warning',
      text: 'That page range names no pages, so nothing was changed.',
    });
    return { action: 'cancel' };
  }
  return { action: 'apply', spec: currentSpec(), pages, range: rangeInput?.input.value ?? '' };
}

/**
 * The preview pane: one page of the document, decorated, rendered by the engine.
 *
 * A scratch document holds a copy of the page, so nothing here can touch the document the reader
 * is editing. Every request supersedes the one before it, and a request that arrives while
 * another is running waits rather than racing it — two `setDecorations` calls on the same page at
 * once would interleave.
 */
class DecorationPreview {
  readonly element = el('div.decoration-preview', {
    'data-testid': 'decoration-preview',
    role: 'img',
    'aria-label': 'Preview of the page with the marks on it',
  });
  readonly controls = el('div.decoration-preview-controls');
  private readonly canvas = el('canvas.decoration-preview-canvas');
  private readonly status = el('p.decoration-preview-status', { role: 'status' });
  private readonly pageInput = el('input.input.decoration-preview-page', {
    type: 'number',
    min: '1',
    value: '1',
    'aria-label': 'Preview this page',
  });
  private readonly doc: Document;
  private readonly kind: DecorationKind;
  private scratch: DocHandle | null = null;
  private scratchFor = -1;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private queued: { spec: DecorationSpec; pages: ReadonlyArray<number> | null } | null = null;
  private disposed = false;
  private readonly listeners: Array<() => void> = [];

  constructor(doc: Document, kind: DecorationKind) {
    this.doc = doc;
    this.kind = kind;
    this.element.append(this.canvas);
    this.pageInput.max = String(doc.state.pages.length);
    this.controls.append(
      el('label.decoration-preview-label', null, 'Page', this.pageInput),
      this.status,
    );
    this.pageInput.addEventListener('input', () => {
      for (const listener of this.listeners) listener();
    });
  }

  onPageChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  /** Which page the preview is showing, 0-based. */
  private page(): number {
    const typed = Number(this.pageInput.value);
    if (!Number.isFinite(typed)) return 0;
    return Math.max(0, Math.min(this.doc.state.pages.length - 1, Math.round(typed) - 1));
  }

  request(spec: DecorationSpec, pages: ReadonlyArray<number> | null): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.draw(spec, pages);
    }, PREVIEW_DEBOUNCE_MS);
  }

  private async draw(spec: DecorationSpec, pages: ReadonlyArray<number> | null): Promise<void> {
    if (this.running) {
      this.queued = { spec, pages };
      return;
    }
    this.running = true;
    try {
      await this.render(spec, pages);
    } catch {
      this.status.textContent = 'The preview could not be drawn.';
    } finally {
      this.running = false;
      const next = this.queued;
      this.queued = null;
      if (next && !this.disposed) await this.draw(next.spec, next.pages);
    }
  }

  private async render(spec: DecorationSpec, pages: ReadonlyArray<number> | null): Promise<void> {
    const doc = this.doc;
    const index = this.page();
    const modelPage = doc.state.pages[index];
    const engineIndex = modelPage ? doc.enginePage(modelPage.id) : undefined;
    if (engineIndex === undefined) return;
    const scratch = await this.scratchDocument(engineIndex);
    if (this.disposed) return;

    const page = modelPage;
    const inRange = pages === null || pages.includes(index);
    const draws: PlannedDecoration[] = [];
    if (page && inRange) {
      const ordinal = pages ? pages.indexOf(index) + 1 : index + 1;
      const context = pageContextFor(
        doc,
        page,
        Math.max(1, ordinal),
        pages?.length ?? doc.state.pages.length,
        documentContext(doc, new Date().toISOString()),
      );
      const sizes = sourceSizes(doc.custom(XOBJECTS_NAMESPACE));
      const { draw } = drawDecoration('preview', spec, { page: context, sources: sizes });
      if (draw) draws.push(draw);
    }
    const sources: Record<string, PlannedXObject> = {};
    for (const [key, value] of Object.entries(doc.custom(XOBJECTS_NAMESPACE))) {
      if (value && typeof value === 'object') sources[key] = value as PlannedXObject;
    }
    await doc.engine.setDecorations(scratch, 0, draws, {
      sources: sourcesUsed(draws, sources),
      ...(spec.kind === 'header-footer' && spec.shrink > 0 && spec.shrink < 1
        ? { shrink: { from: 0, to: spec.shrink } }
        : {}),
    });
    if (this.disposed) return;

    const size = await doc.engine.pageSize(scratch, 0);
    const box = this.element.getBoundingClientRect();
    const available = Math.max(120, box.width || 320);
    const scale = Math.min(2, available / Math.max(1, size.width));
    const result = await doc.engine.render(scratch, 0, scale);
    if (this.disposed) {
      result.bitmap.close();
      return;
    }
    this.canvas.width = result.bitmap.width;
    this.canvas.height = result.bitmap.height;
    this.canvas.style.width = `${String(Math.round(result.bitmap.width / devicePixelRatioOf()))}px`;
    const context = this.canvas.getContext('2d');
    context?.drawImage(result.bitmap, 0, 0);
    result.bitmap.close();
    this.status.textContent = inRange
      ? `Page ${String(index + 1)} of ${String(this.doc.state.pages.length)}`
      : `Page ${String(index + 1)} is not in the range, so it shows without the ${label(this.kind)}`;
  }

  /** A one-page document holding a copy of `engineIndex`, reused while the page does not change. */
  private async scratchDocument(engineIndex: number): Promise<DocHandle> {
    if (this.scratch !== null && this.scratchFor === engineIndex) return this.scratch;
    await this.closeScratch();
    const scratch = await this.doc.engine.createDocument();
    await this.doc.engine.importPages(scratch, this.doc.handle, [engineIndex], 0);
    this.scratch = scratch;
    this.scratchFor = engineIndex;
    return scratch;
  }

  private async closeScratch(): Promise<void> {
    const scratch = this.scratch;
    this.scratch = null;
    this.scratchFor = -1;
    if (scratch !== null) {
      try {
        await this.doc.engine.close(scratch);
      } catch {
        // A document that would not close is not worth telling the reader about.
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    void this.closeScratch();
  }
}

function devicePixelRatioOf(): number {
  return typeof window === 'undefined' ? 1 : Math.max(1, window.devicePixelRatio || 1);
}

function label(kind: DecorationKind): string {
  switch (kind) {
    case 'header-footer':
      return 'header and footer';
    case 'bates':
      return 'numbering';
    case 'background':
      return 'background';
    default:
      return 'watermark';
  }
}
