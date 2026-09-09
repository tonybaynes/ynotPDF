/**
 * `DrawingService` (M31) — shapes, ink, the eraser, stamps and file attachments. Registered as the
 * service `"drawing"`.
 *
 * It creates; M30's `AnnotationService` owns everything after that — the overlay, the selection,
 * moving, resizing, deleting, copy and paste, the properties panel — through the provider this
 * module registers (`provider.ts`). What is here:
 *
 * - **Creation**, one `Command` per shape, stroke, stamp or attachment, grouped where a gesture
 *   makes more than one (a stamp and its picture; an attachment's file and its annotation).
 * - **Ink grouping**: strokes drawn close together join one Ink annotation, and the eraser cuts
 *   or removes strokes as the setting says.
 * - **Stamps**: the catalogue, the reader's favourites and custom stamps, dynamic tokens, and the
 *   shared picture each placement refers to — registered once per document in
 *   `custom.xobjects`, which is what makes ten placements one embedded object (ADR 0015).
 * - **The live page**: a Square, a Circle or an Ink gets the appearance the writer will bake
 *   pushed into PDFium the moment it changes, so the raster shows the cloud or the smoothed
 *   stroke rather than PDFium's own plainer drawing.
 */

import type { ShellServices } from '@app/services';
import type { Registry } from '@core/Registry';
import type { Document } from '@core/Document';
import type { ModelId } from '@core/Ids';
import type { ModelAnnotation, AnnotationPatch } from '@core/model';
import {
  AddAnnotationCommand,
  DeleteAnnotationCommand,
  SetCustomCommand,
  UpdateAnnotationCommand,
  draftAnnotation,
} from '@core/commands';
import type { EngineClient } from '@engine/EngineClient';
import type { PdfEngine } from '@engine/PdfEngine';
import {
  appearanceInput,
  defaultAppearanceService,
  inkRect,
  isDynamicStamp,
  parseStampCatalogue,
  resolveStampTokens,
  shapeRectFor,
  splitStroke,
  stampDrawing,
  stampForm,
  stampKey,
  stampRectAt,
  stampSizeOf,
  strokeHit,
  STAMP_KEY,
  STAMP_SIZE,
  type StampCatalogue,
  type StampDefinition,
  type StampDrawing,
} from '@engine/appearance';
import { hasBridge, invoke } from '@shared/ipc';
import type { PdfPoint, PdfRect } from '@shared/pdf';
import type { PlannedXObject } from '@engine/Writer';
import { toAppearanceInput, XOBJECTS_NAMESPACE } from '@modules/M21-save/plan';
import type { AnnotationService } from '@modules/M30-markup-annotations/AnnotationService';
import catalogueJson from '../../../../resources/stamps/catalogue.json';
import { AttachFileCommand } from './commands';
import { quadOfRect } from './geometry';
import { AREA_HIGHLIGHT_INTENT, isDrawing, type StampPicture } from './overlay';
import {
  DEFAULT_DRAWING_SETTINGS,
  DRAWING_TOOLS,
  factoryDrawingDefaults,
  ipcSettingsStorage,
  readCustomStamps,
  readDrawingDefaults,
  readDrawingSettings,
  writeCustomStamps,
  writeDrawingDefaults,
  writeDrawingSetting,
  type CustomStamp,
  type DrawingDefaults,
  type DrawingSettings,
  type DrawingToolId,
  type SettingsStorage,
} from './settings';
import { pngDataUrl } from './stampImport';

export const DRAWING_SERVICE = 'drawing';
export const STAMP_PANEL_ID = 'nav.stamps';

/** The shape tools, and the subtype each writes. */
export const SHAPE_TOOL_SUBTYPE = {
  rectangle: 'Square',
  ellipse: 'Circle',
  line: 'Line',
  arrow: 'Line',
  polygon: 'Polygon',
  polyline: 'PolyLine',
  cloud: 'Polygon',
  areaHighlight: 'Highlight',
} as const;

export type ShapeToolId = keyof typeof SHAPE_TOOL_SUBTYPE;

/** A stamp the palette offers: from the catalogue, or one the reader imported. */
export type StampEntry =
  | { readonly kind: 'catalogue'; readonly definition: StampDefinition }
  | { readonly kind: 'custom'; readonly stamp: CustomStamp };

export type DrawingListener = () => void;

/** What the eraser did in one pass. */
export interface EraseResult {
  readonly changed: number;
}

export class DrawingService {
  private readonly registry: Registry;
  private readonly shell: ShellServices;
  private readonly engine: PdfEngine;
  private readonly client: EngineClient | null;
  private readonly annotations: AnnotationService;
  private readonly storage: SettingsStorage;
  private readonly listeners = new Set<DrawingListener>();
  private readonly toolDefaults = new Map<DrawingToolId, DrawingDefaults>();
  private readonly catalogueValue: StampCatalogue;
  /** Catalogue drawings by stamp key, so the overlay can draw a placed stamp without the file. */
  private readonly drawings = new Map<string, StampDrawing>();
  private settingsValue: DrawingSettings = DEFAULT_DRAWING_SETTINGS;
  private customStampsValue: CustomStamp[] = [];
  private loading: Promise<void> | null = null;
  /** The Ink annotation strokes are being added to, while the pencil group is open. */
  private inkGroup: { id: ModelId; page: number; documentId: string; lastAt: number } | null = null;

  constructor(options: {
    readonly registry: Registry;
    readonly shell: ShellServices;
    readonly engine: PdfEngine;
    readonly annotations: AnnotationService;
    readonly client?: EngineClient;
    readonly storage?: SettingsStorage;
    readonly catalogue?: StampCatalogue;
  }) {
    this.registry = options.registry;
    this.shell = options.shell;
    this.engine = options.engine;
    this.client = options.client ?? null;
    this.annotations = options.annotations;
    this.storage = options.storage ?? ipcSettingsStorage();
    this.catalogueValue = options.catalogue ?? parseStampCatalogue(catalogueJson);
    for (const tool of DRAWING_TOOLS) this.toolDefaults.set(tool, factoryDrawingDefaults(tool));
  }

  // ---- settings ---------------------------------------------------------------------------------

  get settings(): DrawingSettings {
    return this.settingsValue;
  }

  async load(): Promise<void> {
    this.loading ??= (async () => {
      this.settingsValue = await readDrawingSettings(this.storage);
      this.customStampsValue = await readCustomStamps(this.storage);
      for (const tool of DRAWING_TOOLS) {
        this.toolDefaults.set(tool, await readDrawingDefaults(this.storage, tool));
      }
      this.notify();
    })();
    await this.loading;
  }

  /** Waits for the first settings read, so nothing writes into a value it is about to replace. */
  private async settled(): Promise<void> {
    if (this.loading) await this.loading;
  }

  async setSetting<K extends keyof DrawingSettings>(
    name: K,
    value: DrawingSettings[K],
  ): Promise<void> {
    await this.settled();
    this.settingsValue = { ...this.settingsValue, [name]: value };
    await writeDrawingSetting(this.storage, name, value);
    this.notify();
  }

  defaults(tool: DrawingToolId): DrawingDefaults {
    return this.toolDefaults.get(tool) ?? factoryDrawingDefaults(tool);
  }

  /** "Set as default": the current values of a tool, remembered for the next annotation. */
  async setDefaults(
    tool: DrawingToolId,
    patch: Partial<DrawingDefaults>,
  ): Promise<DrawingDefaults> {
    await this.settled();
    const next = { ...this.defaults(tool), ...patch };
    this.toolDefaults.set(tool, next);
    await writeDrawingDefaults(this.storage, tool, next);
    this.notify();
    return next;
  }

  subscribe(listener: DrawingListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
    this.shell.invalidate();
  }

  // ---- the stamp catalogue ----------------------------------------------------------------------

  get catalogue(): StampCatalogue {
    return this.catalogueValue;
  }

  get customStamps(): ReadonlyArray<CustomStamp> {
    return this.customStampsValue;
  }

  get favourites(): ReadonlyArray<string> {
    return this.settingsValue.favouriteStamps;
  }

  isFavourite(id: string): boolean {
    return this.settingsValue.favouriteStamps.includes(id);
  }

  async toggleFavourite(id: string): Promise<boolean> {
    const has = this.isFavourite(id);
    await this.setSetting(
      'favouriteStamps',
      has ? this.favourites.filter((f) => f !== id) : [...this.favourites, id],
    );
    return !has;
  }

  /** Every stamp, catalogue first then custom. */
  allStamps(): StampEntry[] {
    return [
      ...this.catalogueValue.stamps.map((definition): StampEntry => ({
        kind: 'catalogue',
        definition,
      })),
      ...this.customStampsValue.map((stamp): StampEntry => ({ kind: 'custom', stamp })),
    ];
  }

  stampEntry(id: string): StampEntry | null {
    return this.allStamps().find((e) => stampEntryId(e) === id) ?? null;
  }

  /** Adds an imported stamp. The PNG is stored as base64 in the settings, with its size. */
  async addCustomStamp(input: {
    readonly label: string;
    readonly png: Uint8Array;
    readonly width: number;
    readonly height: number;
  }): Promise<CustomStamp> {
    await this.settled();
    const stamp: CustomStamp = {
      id: `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      label: input.label.trim() === '' ? 'Custom stamp' : input.label.trim(),
      data: base64Of(input.png),
      width: input.width,
      height: input.height,
      created: new Date().toISOString(),
    };
    this.customStampsValue = [...this.customStampsValue, stamp];
    await writeCustomStamps(this.storage, this.customStampsValue);
    this.notify();
    return stamp;
  }

  async removeCustomStamp(id: string): Promise<boolean> {
    await this.settled();
    const before = this.customStampsValue.length;
    this.customStampsValue = this.customStampsValue.filter((s) => s.id !== id);
    if (this.customStampsValue.length === before) return false;
    await writeCustomStamps(this.storage, this.customStampsValue);
    if (this.isFavourite(id)) await this.toggleFavourite(id);
    this.notify();
    return true;
  }

  async renameCustomStamp(id: string, label: string): Promise<boolean> {
    await this.settled();
    const stamp = this.customStampsValue.find((s) => s.id === id);
    if (!stamp || label.trim() === '') return false;
    this.customStampsValue = this.customStampsValue.map((s) =>
      s.id === id ? { ...s, label: label.trim() } : s,
    );
    await writeCustomStamps(this.storage, this.customStampsValue);
    this.notify();
    return true;
  }

  /** The drawing of a catalogue stamp as it would be placed now, tokens resolved. */
  drawingFor(
    definition: StampDefinition,
    now = new Date(),
  ): { lines: string[]; drawing: StampDrawing; key: string } {
    const identity = this.annotations.identity;
    const lines = definition.lines.map((line) =>
      resolveStampTokens(line, { name: identity.name, initials: identity.initials, now }),
    );
    const drawing = stampDrawing(lines, definition.color);
    const key = stampKey(definition.id, lines, definition.color);
    return { lines, drawing, key };
  }

  /** A stamp's picture for the overlay, when the model knows it. */
  stampPicture(a: ModelAnnotation): StampPicture {
    const key = a.extra[STAMP_KEY];
    if (typeof key !== 'string') return null;
    const drawing = this.drawings.get(key);
    if (drawing) return { kind: 'drawing', drawing };
    const document = this.annotations.activeDocument();
    const source = document?.custom(XOBJECTS_NAMESPACE)[key];
    if (source && typeof source === 'object') {
      const r = source as Record<string, unknown>;
      if (r['kind'] === 'image' && typeof r['data'] === 'string') {
        return { kind: 'image', href: pngDataUrl(r['data']) };
      }
    }
    // A catalogue stamp placed in an earlier session: the drawing is rebuilt from its id, but
    // only when it has no dynamic text, which the file alone cannot give back.
    const entry = typeof a.extra['icon'] === 'string' ? this.stampEntry(a.extra['icon']) : null;
    if (entry?.kind === 'catalogue' && !isDynamicStamp(entry.definition)) {
      const built = this.drawingFor(entry.definition);
      if (built.key === key) {
        this.drawings.set(key, built.drawing);
        return { kind: 'drawing', drawing: built.drawing };
      }
    }
    return null;
  }

  /** Whether a placed stamp can be turned: its picture has to be known to redraw it. */
  canRotate(a: ModelAnnotation): boolean {
    return a.family === 'stamp' && this.stampPicture(a) !== null && stampSizeOf(a.extra) !== null;
  }

  // ---- creation ---------------------------------------------------------------------------------

  private async target(page: number): Promise<{ document: Document; pageId: ModelId } | null> {
    const document = this.annotations.activeDocument();
    const modelPage = document?.state.pages[page];
    if (!document || !modelPage) return null;
    await this.annotations.ensurePage(document, page);
    return { document, pageId: modelPage.id };
  }

  /**
   * A shape. `rect` for a rectangle, an ellipse or an area highlight; `vertices` for a line, an
   * arrow, a polygon, a polyline or a cloud — the rect is then computed around them.
   */
  async createShape(
    tool: ShapeToolId,
    page: number,
    geometry: { readonly rect?: PdfRect; readonly vertices?: ReadonlyArray<PdfPoint> },
  ): Promise<ModelId | null> {
    const found = await this.target(page);
    if (!found) return null;
    const { document, pageId } = found;
    const defaults = this.defaults(tool);
    const subtype = SHAPE_TOOL_SUBTYPE[tool];
    const common = await this.annotations.commonFields(defaults.subject);
    const extra: Record<string, unknown> = {};
    if (defaults.dashArray.length > 0 && tool !== 'areaHighlight') {
      extra['dashArray'] = [...defaults.dashArray];
    }
    let rect: PdfRect;
    let source: Record<string, unknown>;
    switch (subtype) {
      case 'Highlight': {
        rect = geometry.rect ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
        extra['intent'] = AREA_HIGHLIGHT_INTENT;
        source = { color: defaults.color, quadPoints: quadOfRect(rect) };
        break;
      }
      case 'Square':
      case 'Circle': {
        rect = geometry.rect ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
        if (tool === 'cloud') extra['cloudy'] = defaults.cloudy;
        source = {
          color: defaults.color,
          interiorColor: defaults.fillColor,
          borderWidth: defaults.borderWidth,
        };
        break;
      }
      default: {
        const vertices = geometry.vertices ?? [];
        if (vertices.length < (subtype === 'Polygon' ? 3 : 2)) return null;
        if (subtype === 'Line' && tool === 'arrow') extra['intent'] = 'LineArrow';
        if (subtype !== 'Polygon') extra['lineEndings'] = [...defaults.lineEndings];
        if (tool === 'cloud') {
          extra['cloudy'] = defaults.cloudy;
          extra['intent'] = 'PolygonCloud';
        }
        rect = shapeRectFor(subtype, vertices, defaults.borderWidth, extra);
        source = {
          color: defaults.color,
          interiorColor: subtype === 'PolyLine' ? null : defaults.fillColor,
          borderWidth: defaults.borderWidth,
          paths: [vertices],
        };
      }
    }
    if (rect.x1 - rect.x0 < 0.5 && rect.y1 - rect.y0 < 0.5) return null;
    const draft = draftAnnotation(document, pageId, {
      subtype,
      rect,
      ...common,
      ...source,
      extra,
    } as never);
    await document.apply(new AddAnnotationCommand(document, draft));
    this.annotations.markEdited(draft.id);
    await this.pushAppearance(document.annotation(draft.id));
    this.annotations.select([draft.id]);
    this.annotations.completeCreation();
    return draft.id;
  }

  /**
   * One pencil stroke. Strokes drawn within `inkGroupMs` of each other on the same page join the
   * same Ink annotation (one path each); a pause, another page or the setting being off starts a
   * new one. Each stroke is its own undo step either way.
   */
  async addInkStroke(
    page: number,
    points: ReadonlyArray<PdfPoint>,
    pressures: ReadonlyArray<number> | null,
  ): Promise<ModelId | null> {
    if (points.length === 0) return null;
    const found = await this.target(page);
    if (!found) return null;
    const { document, pageId } = found;
    const defaults = this.defaults('pencil');
    const now = Date.now();
    const usePressure =
      this.settingsValue.pressure &&
      pressures !== null &&
      pressures.length === points.length &&
      pressures.some((p) => Math.abs(p - 0.5) > 0.05);
    const group = this.inkGroup;
    const existing =
      group &&
      this.settingsValue.inkGroupStrokes &&
      group.page === page &&
      group.documentId === document.id &&
      now - group.lastAt <= this.settingsValue.inkGroupMs
        ? document.annotation(group.id)
        : null;
    if (existing?.family === 'ink') {
      const paths = [...existing.paths, points];
      const previous = pressuresOf(existing);
      const nextPressures =
        usePressure || previous
          ? [
              ...(previous ?? existing.paths.map((p) => p.map(() => 0.5))),
              usePressure && pressures ? [...pressures] : points.map(() => 0.5),
            ]
          : null;
      const patch: AnnotationPatch = {
        paths,
        rect: inkRect(paths, existing.borderWidth ?? defaults.borderWidth, nextPressures),
        extra: nextPressures
          ? { ...existing.extra, pressures: nextPressures }
          : withoutKey(existing.extra, 'pressures'),
      };
      // A stroke is one undo step: the update must not merge into the previous stroke's.
      document.breakMerge();
      await this.annotations.patch(existing.id, patch);
      document.breakMerge();
      this.inkGroup = { id: existing.id, page, documentId: document.id, lastAt: now };
      return existing.id;
    }
    const common = await this.annotations.commonFields(defaults.subject);
    const extra: Record<string, unknown> = {};
    if (usePressure && pressures) extra['pressures'] = [[...pressures]];
    if (defaults.dashArray.length > 0) extra['dashArray'] = [...defaults.dashArray];
    const draft = draftAnnotation(document, pageId, {
      subtype: 'Ink',
      rect: inkRect([points], defaults.borderWidth, usePressure ? [[]] : null),
      color: defaults.color,
      borderWidth: defaults.borderWidth,
      paths: [points],
      ...common,
      extra,
    } as never);
    await document.apply(new AddAnnotationCommand(document, draft));
    this.annotations.markEdited(draft.id);
    await this.pushAppearance(document.annotation(draft.id));
    this.inkGroup = { id: draft.id, page, documentId: document.id, lastAt: now };
    return draft.id;
  }

  /** Ends the current pencil group: the next stroke starts a new annotation. */
  endInkGroup(): void {
    if (this.inkGroup) {
      this.annotations.select([this.inkGroup.id]);
      this.annotations.completeCreation();
    }
    this.inkGroup = null;
  }

  /**
   * One pass of the eraser at a page point. In `split` mode a stroke it crosses is cut: the part
   * before the cut stays with its annotation, and every later fragment becomes an annotation of
   * its own with the same look. In `stroke` mode the whole stroke goes. An annotation left with no
   * strokes is deleted. One composite command per pass.
   */
  async erase(
    page: number,
    center: PdfPoint,
    radius = this.settingsValue.eraserRadius,
  ): Promise<EraseResult> {
    const found = await this.target(page);
    if (!found) return { changed: 0 };
    const { document, pageId } = found;
    const mode = this.settingsValue.eraserMode;
    const targets = document
      .annotations(pageId)
      .filter(
        (a): a is Extract<ModelAnnotation, { family: 'ink' }> =>
          a.family === 'ink' &&
          !a.flags.locked &&
          !a.flags.readOnly &&
          a.paths.some((path) => strokeHit(path, center, radius)),
      );
    if (targets.length === 0) return { changed: 0 };
    let changed = 0;
    await document.batch('Erase', async () => {
      for (const a of targets) {
        const pressures = pressuresOf(a);
        const kept: PdfPoint[][] = [];
        const keptPressures: number[][] = [];
        const born: { path: PdfPoint[]; pressure: number[] | null }[] = [];
        a.paths.forEach((path, index) => {
          const pressure = pressures?.[index] ?? null;
          if (!strokeHit(path, center, radius)) {
            kept.push([...path]);
            keptPressures.push(pressure ? [...pressure] : path.map(() => 0.5));
            return;
          }
          if (mode === 'stroke') return;
          const fragments = splitStroke(path, center, radius);
          fragments.forEach((fragment, i) => {
            const fragmentPressure = pressure
              ? fragment.map((p) => pressure[path.indexOf(p)] ?? 0.5)
              : null;
            if (i === 0) {
              kept.push(fragment);
              keptPressures.push(fragmentPressure ?? fragment.map(() => 0.5));
            } else {
              born.push({ path: fragment, pressure: fragmentPressure });
            }
          });
        });
        const width = a.borderWidth ?? 1;
        if (kept.length === 0) {
          await document.apply(new DeleteAnnotationCommand(document, a.id));
        } else {
          const extra = pressures
            ? { ...a.extra, pressures: keptPressures }
            : withoutKey(a.extra, 'pressures');
          document.breakMerge();
          await document.apply(
            new UpdateAnnotationCommand(document, a.id, {
              paths: kept,
              rect: inkRect(kept, width, pressures ? keptPressures : null),
              extra,
              modified: new Date().toISOString(),
            }),
          );
          this.annotations.markEdited(a.id);
          await this.pushAppearance(document.annotation(a.id));
        }
        for (const piece of born) {
          const extra = piece.pressure
            ? { ...withoutKey(a.extra, 'hasAP'), pressures: [piece.pressure] }
            : withoutKey(withoutKey(a.extra, 'hasAP'), 'pressures');
          const draft = draftAnnotation(document, pageId, {
            subtype: 'Ink',
            rect: inkRect([piece.path], width, piece.pressure ? [piece.pressure] : null),
            color: a.color,
            borderWidth: a.borderWidth,
            paths: [piece.path],
            author: a.author,
            created: a.created,
            modified: new Date().toISOString(),
            subject: a.subject,
            flags: a.flags,
            opacity: a.opacity,
            contents: a.contents,
            extra,
          } as never);
          await document.apply(new AddAnnotationCommand(document, draft));
          this.annotations.markEdited(draft.id);
          await this.pushAppearance(document.annotation(draft.id));
        }
        changed++;
      }
    });
    document.breakMerge();
    if (changed > 0) this.annotations.clearSelection();
    return { changed };
  }

  /**
   * Places a stamp centred on a page point (or fitted into a rect), at `rotate` degrees.
   *
   * The stamp's picture is registered once per document, keyed, so a second placement of the same
   * stamp refers to the object the first one embedded (ADR 0015). A catalogue stamp's key includes
   * its resolved text, so two dynamic stamps a minute apart are two pictures — as they must be.
   */
  async placeStamp(
    stampId: string,
    page: number,
    at: PdfPoint | PdfRect,
    rotate = 0,
  ): Promise<ModelId | null> {
    const entry = this.stampEntry(stampId);
    const found = await this.target(page);
    if (!entry || !found) return null;
    const { document, pageId } = found;
    const defaults = this.defaults('stamp');
    let key: string;
    let size: { width: number; height: number };
    let source: PlannedXObject;
    let subject: string;
    if (entry.kind === 'catalogue') {
      const built = this.drawingFor(entry.definition);
      key = built.key;
      size = { width: built.drawing.width, height: built.drawing.height };
      const form = stampForm(built.drawing);
      source = { kind: 'form', content: form.content, bbox: form.bbox, resources: form.resources };
      this.drawings.set(key, built.drawing);
      subject = entry.definition.label;
    } else {
      key = `image:${entry.stamp.id}`;
      size = { width: entry.stamp.width, height: entry.stamp.height };
      source = {
        kind: 'image',
        format: 'png',
        data: entry.stamp.data,
        width: entry.stamp.width,
        height: entry.stamp.height,
      };
      subject = entry.stamp.label;
    }
    const rect = isRect(at)
      ? at
      : stampRectAt(at, size, entry.kind === 'catalogue' ? 1 : initialImageScale(size), rotate);
    const common = await this.annotations.commonFields(
      defaults.subject === 'Stamp' ? subject : defaults.subject,
    );
    const draft = draftAnnotation(document, pageId, {
      subtype: 'Stamp',
      rect,
      ...common,
      extra: {
        icon: stampId,
        [STAMP_KEY]: key,
        [STAMP_SIZE]: [size.width, size.height],
        ...(rotate === 0 ? {} : { rotate }),
      },
    } as never);
    await document.batch(`Place ${subject} stamp`, async () => {
      await this.registerXObject(document, key, source);
      await document.apply(new AddAnnotationCommand(document, draft));
    });
    this.annotations.markEdited(draft.id);
    this.annotations.select([draft.id]);
    await this.setDefaults('stamp', { stampId });
    this.annotations.completeCreation();
    return draft.id;
  }

  /** Turns a placed stamp. The appearance the file had is dropped, since it no longer matches. */
  async setStampRotation(id: ModelId, degrees: number): Promise<boolean> {
    const document = this.annotations.activeDocument();
    const a = document?.annotation(id);
    if (!document || a?.family !== 'stamp' || !this.canRotate(a)) return false;
    const rotate = ((Math.round(degrees) % 360) + 360) % 360;
    await this.ensureStampSource(document, a);
    if (a.extra['hasAP'] === true) {
      const engineId = document.idTable.engineKey('annotation', id);
      if (engineId !== undefined) {
        await this.engine
          .setAnnotationAppearance(document.handle, engineId, null)
          .catch(() => undefined);
      }
    }
    await this.annotations.patch(id, {
      extra: { ...withoutKey(a.extra, 'hasAP'), rotate, hasAP: false },
    });
    return true;
  }

  /** Makes sure the document carries the picture a stamp refers to (after a reopen, it may not). */
  async ensureStampSource(document: Document, a: ModelAnnotation): Promise<void> {
    const key = a.extra[STAMP_KEY];
    if (typeof key !== 'string' || key in document.custom(XOBJECTS_NAMESPACE)) return;
    const picture = this.stampPicture(a);
    if (picture?.kind !== 'drawing') return;
    const form = stampForm(picture.drawing);
    await this.registerXObject(document, key, {
      kind: 'form',
      content: form.content,
      bbox: form.bbox,
      resources: form.resources,
    });
  }

  private async registerXObject(
    document: Document,
    key: string,
    source: PlannedXObject,
  ): Promise<void> {
    if (key in document.custom(XOBJECTS_NAMESPACE)) return;
    await document.apply(
      new SetCustomCommand(document, XOBJECTS_NAMESPACE, { [key]: source }, 'Embed stamp picture'),
    );
  }

  /**
   * Attaches a file to a page: the bytes go into the document through the engine, the record is
   * pinned to the page, and a FileAttachment annotation shows where. One composite command.
   */
  async attachFile(
    page: number,
    at: PdfPoint,
    file?: { readonly name: string; readonly bytes: Uint8Array; readonly description?: string },
  ): Promise<ModelId | null> {
    const chosen = file ?? (await this.chooseFile());
    if (!chosen) return null;
    const found = await this.target(page);
    if (!found) return null;
    const { document, pageId } = found;
    const defaults = this.defaults('attachFile');
    const common = await this.annotations.commonFields(defaults.subject);
    const size = 20;
    const rect: PdfRect = { x0: at.x, y0: at.y - size, x1: at.x + size, y1: at.y };
    const draft = draftAnnotation(document, pageId, {
      subtype: 'FileAttachment',
      rect,
      color: defaults.color,
      ...common,
      contents: chosen.description ?? chosen.name,
      extra: { icon: defaults.icon, attachmentName: chosen.name },
    } as never);
    await document.batch(`Attach ${chosen.name}`, async () => {
      await document.apply(
        new AttachFileCommand(document, pageId, {
          name: chosen.name,
          bytes: chosen.bytes,
          description: chosen.description ?? null,
          mimeType: mimeOfName(chosen.name),
        }),
      );
      await document.apply(new AddAnnotationCommand(document, draft));
    });
    this.annotations.markEdited(draft.id);
    this.annotations.select([draft.id]);
    this.annotations.completeCreation();
    return draft.id;
  }

  /** The model attachment a FileAttachment annotation shows, by the name it carries. */
  attachmentOf(a: ModelAnnotation): ModelId | null {
    const document = this.annotations.activeDocument();
    if (!document || a.family !== 'fileAttachment') return null;
    if (a.attachmentId) return a.attachmentId;
    const name = a.extra['attachmentName'];
    const byName =
      typeof name === 'string'
        ? document.state.attachments.find((att) => att.name === name)
        : undefined;
    if (byName) return byName.id;
    // Reopened from a file: the engine lists the annotation's own file, keyed by its position.
    const engineId = document.idTable.engineKey('annotation', a.id);
    const m = engineId ? /^a(\d+)\.(\d+)$/.exec(engineId) : null;
    if (!m) return null;
    const wanted = `annot.${m[1] ?? ''}.${m[2] ?? ''}`;
    return document.state.attachments.find((att) => att.engineId === wanted)?.id ?? null;
  }

  private async chooseFile(): Promise<{
    name: string;
    bytes: Uint8Array;
    description?: string;
  } | null> {
    if (!hasBridge()) return null;
    const files = await invoke('file:openFilesDialog', {
      title: 'Choose a file to attach',
      buttonLabel: 'Attach',
      multi: false,
    });
    const first = files[0];
    return first ? { name: first.name, bytes: first.bytes } : null;
  }

  // ---- the live page ----------------------------------------------------------------------------

  /**
   * Hands PDFium the appearance the writer will bake, for the subtypes it can hold one for.
   *
   * PDFium draws a Square, a Circle and an Ink itself as the page loads, but its drawing knows
   * nothing of clouds, dashes or smoothing. Ours is pure vector, so it can go through
   * `setAnnotationAppearance` (ADR 0013) and the raster then shows exactly what the file will.
   */
  async pushAppearance(a: ModelAnnotation | null): Promise<void> {
    if (!a || !isDrawing(a)) return;
    if (a.subtype !== 'Square' && a.subtype !== 'Circle' && a.subtype !== 'Ink') return;
    const document = this.annotations.activeDocument();
    if (!document) return;
    const engineId = document.idTable.engineKey('annotation', a.id);
    if (engineId === undefined) return;
    const stream = defaultAppearanceService.generate(toAppearanceInput(a));
    try {
      await this.engine.setAnnotationAppearance(document.handle, engineId, stream?.content ?? null);
    } catch {
      // A backend without the call keeps its own drawing; the file still gets ours.
    }
  }

  /** After any change to one of ours: the provider's `afterChange`. */
  async afterChange(a: ModelAnnotation): Promise<void> {
    await this.pushAppearance(a);
  }

  /** The engine client, for rendering a PDF page into a custom stamp. */
  get engineClient(): EngineClient | null {
    return this.client;
  }

  get shellServices(): ShellServices {
    return this.shell;
  }

  get annotationService(): AnnotationService {
    return this.annotations;
  }

  hasRegistry(name: string): boolean {
    return this.registry.hasService(name);
  }

  dispose(): void {
    this.listeners.clear();
    this.inkGroup = null;
  }
}

// ---- helpers --------------------------------------------------------------------------------------

/** The id the palette and the settings use for an entry. */
export function stampEntryId(entry: StampEntry): string {
  return entry.kind === 'catalogue' ? entry.definition.id : entry.stamp.id;
}

export function stampEntryLabel(entry: StampEntry): string {
  return entry.kind === 'catalogue' ? entry.definition.label : entry.stamp.label;
}

/** A custom picture is pixels; it starts at most three inches along its longer side. */
export function initialImageScale(size: {
  readonly width: number;
  readonly height: number;
}): number {
  const longest = Math.max(size.width, size.height, 1);
  return Math.min(1, 216 / longest);
}

function isRect(value: PdfPoint | PdfRect): value is PdfRect {
  return 'x0' in value;
}

function pressuresOf(a: ModelAnnotation): number[][] | null {
  const raw = a.extra['pressures'];
  if (!Array.isArray(raw)) return null;
  return raw.map((p) =>
    Array.isArray(p) ? p.filter((n): n is number => typeof n === 'number') : [],
  );
}

function withoutKey(
  extra: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, unknown> {
  const { [key]: _dropped, ...rest } = extra;
  return rest;
}

function base64Of(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** A MIME type from a file name, for the handful a reader is likely to attach. */
export function mimeOfName(name: string): string | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const table: Record<string, string> = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    txt: 'text/plain',
    csv: 'text/csv',
    json: 'application/json',
    xml: 'application/xml',
    zip: 'application/zip',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return table[ext] ?? null;
}

/** Whether an annotation's stamp picture is a custom image (as opposed to a catalogue drawing). */
export function isImageStamp(a: ModelAnnotation): boolean {
  const key = a.extra[STAMP_KEY];
  return typeof key === 'string' && key.startsWith('image:');
}

export { appearanceInput };
