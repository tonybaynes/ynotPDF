/**
 * `MeasureService` (M33) — distance, perimeter, area and calibration. Registered as `"measure"`.
 *
 * It creates; M30's `AnnotationService` owns everything after that — the overlay, the selection,
 * moving, resizing, deleting, copy and paste, the properties panel — through the provider this
 * module registers (`provider.ts`, priority 10, ADR 0018). What is here:
 *
 * - **Creation**, one `Command` per measurement, each carrying its own `/Measure` so it reopens
 *   with the value it was made with whatever the document's scale is by then.
 * - **The scale**: the document's, each calibrated page's, and the one a new document starts
 *   with. Calibrating is a `SetCustomCommand`, so it is undoable and in the recovery file.
 * - **Snapping**: the page's path outlines from the engine (or its object boxes, when the backend
 *   has no path data), cached per page and revision, and the nearest candidate to a point.
 * - **The results**: every measurement in the document, the totals, the live value while a tool
 *   is drawing, and the CSV.
 */

import type { ShellServices } from '@app/services';
import type { Registry } from '@core/Registry';
import type { Document } from '@core/Document';
import type { ModelId } from '@core/Ids';
import type { ModelAnnotation } from '@core/model';
import { AddAnnotationCommand, SetCustomCommand, draftAnnotation } from '@core/commands';
import type { PdfEngine } from '@engine/PdfEngine';
import {
  DEFAULT_MEASURE_SCALE,
  MEASURE_INTENTS,
  POINTS_PER_UNIT,
  formatMeasurement,
  kindOfIntent,
  measureArea,
  measureLength,
  measurementOf,
  pathLength,
  polygonArea,
  scaleRatioText,
  type MeasureIntent,
  type MeasureScale,
  type MeasureUnit,
} from '@engine/appearance';
import { hasBridge, invoke } from '@shared/ipc';
import type { PdfPoint } from '@shared/pdf';
import type { AnnotationService } from '@modules/M30-markup-annotations/AnnotationService';
import { measurementRect } from './provider';
import { isMeasureAnnotation, measurementFor } from './overlay';
import {
  csvBytes,
  resultRows,
  resultTotals,
  rowsToText,
  type ResultRow,
  type ResultTotal,
} from './results';
import {
  EMPTY_SCALE_RECORD,
  MEASURE_NAMESPACE,
  calibrationScale,
  documentScalePatch,
  hasPageScale,
  pageScalePatch,
  readScaleRecord,
  scaleFor,
  type ScaleRecord,
} from './scale';
import { anySnapKind, rectPath, snapAt, type SnapPath, type SnapResult } from './snap';
import {
  DEFAULT_MEASURE_SETTINGS,
  MEASURE_TOOLS,
  factoryMeasureDefaults,
  ipcSettingsStorage,
  readMeasureDefaults,
  readMeasureSettings,
  writeMeasureDefaults,
  writeMeasureSetting,
  type MeasureDefaults,
  type MeasureSettings,
  type MeasureToolId,
  type SettingsStorage,
} from './settings';

export const MEASURE_SERVICE = 'measure';
export const RESULTS_PANEL_ID = 'nav.measurements';

/** The three tools that make a measurement, and the intent each writes. */
export const TOOL_INTENT = {
  distance: MEASURE_INTENTS.Line,
  perimeter: MEASURE_INTENTS.PolyLine,
  area: MEASURE_INTENTS.Polygon,
} as const;

export type MeasuringToolId = keyof typeof TOOL_INTENT;

/** The subtype each intent belongs on. */
const INTENT_SUBTYPE: Readonly<Record<MeasureIntent, 'Line' | 'PolyLine' | 'Polygon'>> = {
  LineDimension: 'Line',
  PolyLineDimension: 'PolyLine',
  PolygonDimension: 'Polygon',
};

/** The value a tool is showing while it draws, before anything is committed. */
export interface LiveMeasurement {
  readonly tool: MeasuringToolId | 'calibrate';
  readonly text: string;
  /** How much has been drawn so far, in the words the panel uses. */
  readonly detail: string;
}

export type MeasureListener = () => void;

/**
 * One page's *content* geometry for snapping, kept for the life of the open document.
 *
 * Deliberately not keyed by the document's revision. Drawing a measurement bumps that on every
 * gesture, and re-reading a CAD page's few thousand paths from the engine between two pointer
 * moves is exactly the wrong moment to do it — while the page's own content, which is all this
 * holds, has not changed at all. What *has* changed is the annotations, and those are gathered
 * fresh on every read (they are a walk over one page's model list, which costs nothing).
 */
interface SnapCache {
  readonly documentId: string;
  readonly paths: SnapPath[];
}

export class MeasureService {
  private readonly registry: Registry;
  private readonly shell: ShellServices;
  private readonly engine: PdfEngine;
  private readonly annotations: AnnotationService;
  private readonly storage: SettingsStorage;
  private readonly listeners = new Set<MeasureListener>();
  private readonly toolDefaults = new Map<MeasureToolId, MeasureDefaults>();
  private readonly snapCache = new Map<number, SnapCache>();
  private readonly pending = new Set<number>();
  private settingsValue: MeasureSettings = DEFAULT_MEASURE_SETTINGS;
  private loading: Promise<void> | null = null;
  private liveValue: LiveMeasurement | null = null;
  private snapValue: SnapResult | null = null;
  /** True while `afterChange` is rewriting a caption, so it does not call itself. */
  private rewriting = false;

  constructor(options: {
    readonly registry: Registry;
    readonly shell: ShellServices;
    readonly engine: PdfEngine;
    readonly annotations: AnnotationService;
    readonly storage?: SettingsStorage;
  }) {
    this.registry = options.registry;
    this.shell = options.shell;
    this.engine = options.engine;
    this.annotations = options.annotations;
    this.storage = options.storage ?? ipcSettingsStorage();
    for (const tool of MEASURE_TOOLS) this.toolDefaults.set(tool, factoryMeasureDefaults(tool));
  }

  // ---- settings -------------------------------------------------------------------------------

  get settings(): MeasureSettings {
    return this.settingsValue;
  }

  async load(): Promise<void> {
    this.loading ??= (async () => {
      this.settingsValue = await readMeasureSettings(this.storage);
      for (const tool of MEASURE_TOOLS) {
        this.toolDefaults.set(tool, await readMeasureDefaults(this.storage, tool));
      }
      this.notify();
    })();
    await this.loading;
  }

  /** Waits for the first settings read, so nothing writes into a value it is about to replace. */
  private async settled(): Promise<void> {
    if (this.loading) await this.loading;
  }

  async setSetting<K extends keyof MeasureSettings>(
    name: K,
    value: MeasureSettings[K],
  ): Promise<void> {
    await this.settled();
    this.settingsValue = { ...this.settingsValue, [name]: value };
    await writeMeasureSetting(this.storage, name, value);
    this.notify();
  }

  defaults(tool: MeasureToolId): MeasureDefaults {
    return this.toolDefaults.get(tool) ?? factoryMeasureDefaults(tool);
  }

  /** "Set as default": the values of the selected measurement, remembered for the next one. */
  async setDefaults(
    tool: MeasureToolId,
    patch: Partial<MeasureDefaults>,
  ): Promise<MeasureDefaults> {
    await this.settled();
    const next = { ...this.defaults(tool), ...patch };
    this.toolDefaults.set(tool, next);
    await writeMeasureDefaults(this.storage, tool, next);
    this.notify();
    return next;
  }

  subscribe(listener: MeasureListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
    this.shell.invalidate();
  }

  // ---- the scale ------------------------------------------------------------------------------

  /** The calibration record of the active document, or the empty one when nothing is open. */
  record(document = this.annotations.activeDocument()): ScaleRecord {
    if (!document) return EMPTY_SCALE_RECORD;
    return readScaleRecord(document.custom(MEASURE_NAMESPACE));
  }

  /** The scale a page measures with: its own, else the document's, else the settings'. */
  scaleFor(page: number | null): MeasureScale {
    const document = this.annotations.activeDocument();
    const pageId = document && page !== null ? (document.state.pages[page]?.id ?? null) : null;
    return scaleFor(this.record(document), pageId, this.settingsValue.scale);
  }

  /** Whether this page has a calibration of its own, rather than inheriting the document's. */
  pageIsCalibrated(page: number): boolean {
    const document = this.annotations.activeDocument();
    const pageId = document?.state.pages[page]?.id ?? null;
    return hasPageScale(this.record(document), pageId);
  }

  /** The ratio in words, for the status line and the panel. */
  ratioText(page: number | null): string {
    return scaleRatioText(this.scaleFor(page));
  }

  /**
   * Sets the scale for the whole document, or for one page.
   *
   * Every measurement that was made with the *old* scale on the pages this touches is re-measured
   * — its own `/Measure` is replaced and its caption rewritten — because a ruler that has moved
   * and captions that have not is the one state a reader cannot tell apart from a correct one.
   */
  async setScale(
    scale: MeasureScale,
    options: { readonly page?: number | null; readonly scope?: 'document' | 'page' } = {},
  ): Promise<boolean> {
    const document = this.annotations.activeDocument();
    if (!document) return false;
    const scope = options.scope ?? 'document';
    const page = options.page ?? null;
    const modelPage = page === null ? null : document.state.pages[page];
    if (scope === 'page' && !modelPage) return false;
    const record = this.record(document);
    const label = scope === 'page' ? 'Calibrate page' : 'Calibrate document';
    await document.batch(label, async () => {
      await document.apply(
        new SetCustomCommand(
          document,
          MEASURE_NAMESPACE,
          scope === 'page' && modelPage
            ? pageScalePatch(record, modelPage.id, scale)
            : documentScalePatch(scale),
          label,
        ),
      );
      await this.remeasure(document, scope === 'page' && modelPage ? modelPage.id : null, scale);
    });
    this.notify();
    return true;
  }

  /** Clears a page's own calibration, so it inherits the document's again. */
  async clearPageScale(page: number): Promise<boolean> {
    const document = this.annotations.activeDocument();
    const modelPage = document?.state.pages[page];
    if (!document || !modelPage) return false;
    const record = this.record(document);
    if (!hasPageScale(record, modelPage.id)) return false;
    await document.apply(
      new SetCustomCommand(
        document,
        MEASURE_NAMESPACE,
        pageScalePatch(record, modelPage.id, null),
        'Clear page calibration',
      ),
    );
    this.notify();
    return true;
  }

  /** Re-measures every measurement on `pageId` (or on every page) against a new scale. */
  private async remeasure(
    document: Document,
    pageId: ModelId | null,
    scale: MeasureScale,
  ): Promise<void> {
    const pages =
      pageId === null ? document.state.pages : document.state.pages.filter((p) => p.id === pageId);
    for (const page of pages) {
      // A page whose annotations were never loaded holds none in the model, so nothing to redo;
      // it will be measured against the new scale the first time it is opened.
      for (const a of document.annotations(page.id)) {
        if (!isMeasureAnnotation(a) || a.family !== 'shape') continue;
        // A page with a calibration of its own keeps it when the *document's* scale changes.
        if (pageId === null && hasPageScale(this.record(document), page.id)) continue;
        const extra = { ...a.extra, measure: scale };
        const vertices = a.vertices;
        const patch = {
          extra,
          rect: measurementRect({ ...a, extra }, vertices),
          ...(this.settingsValue.writeContents ? { contents: this.textFor(a, scale) } : {}),
        };
        await this.annotations.patch(a.id, patch);
        this.annotations.markEdited(a.id);
      }
    }
  }

  /** The caption a measurement would carry under a scale. */
  private textFor(a: ModelAnnotation, scale: MeasureScale): string {
    if (a.family !== 'shape') return '';
    const measurement = measurementOf({
      subtype: a.subtype,
      vertices: a.vertices,
      extra: { ...a.extra, measure: scale },
    });
    return measurement?.text ?? '';
  }

  /**
   * The scale that makes a drawn length mean a stated one — the calibration itself. Pure enough
   * to test on its own; the dialog collects the numbers and this turns them into a scale.
   */
  calibrationFrom(input: {
    readonly pagePoints: number;
    readonly realValue: number;
    readonly unit: MeasureUnit;
    readonly precision?: number;
    readonly denominator?: number;
  }): MeasureScale | null {
    return calibrationScale({
      pagePoints: input.pagePoints,
      realValue: input.realValue,
      unit: input.unit,
      precision: input.precision ?? this.settingsValue.scale.precision,
      ...(input.denominator === undefined ? {} : { denominator: input.denominator }),
      pointsPerUnit: POINTS_PER_UNIT[input.unit],
    });
  }

  // ---- creation -------------------------------------------------------------------------------

  private async target(page: number): Promise<{ document: Document; pageId: ModelId } | null> {
    const document = this.annotations.activeDocument();
    const modelPage = document?.state.pages[page];
    if (!document || !modelPage) return null;
    await this.annotations.ensurePage(document, page);
    return { document, pageId: modelPage.id };
  }

  /**
   * One measurement: a distance (two points), a perimeter (a polyline) or an area (a polygon).
   *
   * The scale in force for the page is baked into the annotation's own `/Measure` at this moment,
   * which is what makes a saved measurement reopen with the value it was made with.
   */
  async createMeasurement(
    tool: MeasuringToolId,
    page: number,
    vertices: ReadonlyArray<PdfPoint>,
  ): Promise<ModelId | null> {
    const found = await this.target(page);
    if (!found) return null;
    const { document, pageId } = found;
    const intent = TOOL_INTENT[tool];
    const subtype = INTENT_SUBTYPE[intent];
    const minimum = subtype === 'Polygon' ? 3 : 2;
    if (vertices.length < minimum) return null;
    const defaults = this.defaults(tool);
    const scale = this.scaleFor(page);
    const common = await this.annotations.commonFields(defaults.subject);
    const extra: Record<string, unknown> = {
      intent,
      measure: scale,
      caption: defaults.caption,
      captionPosition: defaults.captionPosition,
      fontSize: defaults.fontSize,
    };
    if (defaults.dashArray.length > 0) extra['dashArray'] = [...defaults.dashArray];
    // `/LE` belongs on a Line and a PolyLine; a Polygon has no ends to put anything on.
    if (subtype !== 'Polygon') extra['lineEndings'] = [...defaults.lineEndings];
    if (subtype === 'Line') {
      extra['leaderLength'] = defaults.leaderLength;
      extra['leaderExtend'] = defaults.leaderExtend;
      extra['leaderOffset'] = defaults.leaderOffset;
    }
    const points = subtype === 'Line' ? vertices.slice(0, 2) : [...vertices];
    const measurement = measurementOf({ subtype, vertices: points, extra });
    const draft = draftAnnotation(document, pageId, {
      subtype,
      rect: { x0: 0, y0: 0, x1: 0, y1: 0 },
      color: defaults.color,
      // A dimension's interior colour fills nothing: a measured area is drawn as an outline so
      // whatever is being measured stays visible under it.
      interiorColor: null,
      borderWidth: defaults.borderWidth,
      paths: [points],
      ...common,
      ...(this.settingsValue.writeContents && measurement ? { contents: measurement.text } : {}),
      extra,
    } as never);
    const withRect = { ...draft, vertices: points } as ModelAnnotation;
    const placed = { ...draft, rect: measurementRect(withRect, points) } as typeof draft;
    await document.apply(new AddAnnotationCommand(document, placed));
    this.annotations.markEdited(placed.id);
    this.annotations.select([placed.id]);
    this.setLive(null);
    this.annotations.completeCreation();
    this.notify();
    return placed.id;
  }

  /**
   * Calibrates from a drawn line: the scale that makes it `realValue` `unit` long.
   *
   * The line itself is not kept — nothing about it belongs in the document once the ruler has
   * been set — which is also why this is not a measurement annotation with a value of its own.
   */
  async calibrate(input: {
    readonly page: number;
    readonly from: PdfPoint;
    readonly to: PdfPoint;
    readonly realValue: number;
    readonly unit: MeasureUnit;
    readonly precision?: number;
    readonly denominator?: number;
    readonly scope?: 'document' | 'page';
  }): Promise<MeasureScale | null> {
    const pagePoints = Math.hypot(input.to.x - input.from.x, input.to.y - input.from.y);
    const scale = this.calibrationFrom({
      pagePoints,
      realValue: input.realValue,
      unit: input.unit,
      ...(input.precision === undefined ? {} : { precision: input.precision }),
      ...(input.denominator === undefined ? {} : { denominator: input.denominator }),
    });
    if (!scale) return null;
    const ok = await this.setScale(scale, {
      page: input.page,
      scope: input.scope ?? 'page',
    });
    return ok ? scale : null;
  }

  // ---- the live value -------------------------------------------------------------------------

  get live(): LiveMeasurement | null {
    return this.liveValue;
  }

  /** What a tool is showing as it draws. Cleared when the gesture ends. */
  setLive(value: LiveMeasurement | null): void {
    this.liveValue = value;
    this.notify();
  }

  /** The live value for a gesture in progress: the same arithmetic the finished one will use. */
  liveFor(
    tool: MeasuringToolId | 'calibrate',
    page: number,
    points: ReadonlyArray<PdfPoint>,
  ): LiveMeasurement | null {
    if (points.length < 2) return null;
    const scale = this.scaleFor(page);
    if (tool === 'area') {
      const value = measureArea(polygonArea(points), scale);
      return {
        tool,
        text: formatMeasurement(value, scale, 'area'),
        detail: `${String(points.length)} corners`,
      };
    }
    const value = measureLength(pathLength(points), scale);
    const kind = kindOfIntent(tool === 'calibrate' ? 'LineDimension' : TOOL_INTENT[tool]);
    return {
      tool,
      text: formatMeasurement(value, scale, kind),
      detail:
        tool === 'perimeter' ? `${String(points.length - 1)} segments` : scaleRatioText(scale),
    };
  }

  // ---- snapping -------------------------------------------------------------------------------

  get snapIndicator(): SnapResult | null {
    return this.snapValue;
  }

  /** Which kinds of snap are on, as the pure snapper wants them. */
  private snapKinds(): {
    endpoints: boolean;
    midpoints: boolean;
    intersections: boolean;
    paths: boolean;
  } {
    const s = this.settingsValue;
    return {
      endpoints: s.snapEndpoints,
      midpoints: s.snapMidpoints,
      intersections: s.snapIntersections,
      paths: s.snapPaths,
    };
  }

  /**
   * The point a measurement should actually take, given where the pointer is.
   *
   * Synchronous on purpose: it runs on every pointer move, and a promise would put the marker a
   * frame behind the cursor. The page's geometry is fetched in the background the first time it
   * is asked for, so the first move over a page snaps to nothing and every one after it snaps.
   */
  snap(page: number, at: PdfPoint, scale: number): PdfPoint {
    this.snapValue = null;
    if (!this.settingsValue.snap || !anySnapKind(this.snapKinds())) return at;
    const paths = this.snapPaths(page);
    if (!paths) return at;
    const tolerance = this.settingsValue.snapTolerance / Math.max(scale, 1e-6);
    const found = snapAt(at, paths, tolerance, this.snapKinds());
    if (!found) return at;
    this.snapValue = found;
    return found.point;
  }

  /** Clears the snap marker — the gesture ended, or the tool was put away. */
  clearSnap(): void {
    this.snapValue = null;
  }

  /**
   * A page's snap geometry, or null while the page's content is still being fetched.
   *
   * Synchronous, because it runs on every pointer move: the page's content is read in the
   * background the first time a page is asked for and kept, and the annotations on it are added
   * fresh each call so a second distance can start exactly where the first one ended.
   */
  snapPaths(page: number): SnapPath[] | null {
    const document = this.annotations.activeDocument();
    if (!document) return null;
    const cached = this.snapCache.get(page);
    if (cached?.documentId !== document.id && !this.pending.has(page)) {
      this.pending.add(page);
      void this.loadSnapPaths(document, page).finally(() => this.pending.delete(page));
    }
    if (cached?.documentId !== document.id) return null;
    return [...cached.paths, ...this.annotationPaths(document, page)];
  }

  /** The geometry of the annotations already on a page — measurements, shapes and ink. */
  private annotationPaths(document: Document, page: number): SnapPath[] {
    const modelPage = document.state.pages[page];
    if (!modelPage) return [];
    const out: SnapPath[] = [];
    for (const a of document.annotations(modelPage.id)) {
      if (a.flags.hidden || a.flags.noView) continue;
      if (a.family === 'shape' && a.vertices.length >= 2) out.push(a.vertices);
      if (a.family === 'ink')
        for (const stroke of a.paths) if (stroke.length >= 2) out.push(stroke);
    }
    return out;
  }

  /**
   * Reads a page's *content* geometry: the engine's path outlines when it has them, else the
   * bounding box of every object it lists, which still gives corners and edge midpoints.
   */
  private async loadSnapPaths(document: Document, page: number): Promise<void> {
    const paths: SnapPath[] = [];
    try {
      const fromEngine = this.engine.pageObjectPaths
        ? await this.engine.pageObjectPaths(document.handle, page)
        : [];
      for (const object of fromEngine) {
        for (const subpath of object.subpaths) if (subpath.length >= 2) paths.push(subpath);
      }
      if (paths.length === 0) {
        const objects = await this.engine.pageObjects(document.handle, page);
        for (const object of objects) {
          if (object.rect.x1 - object.rect.x0 < 0.5 && object.rect.y1 - object.rect.y0 < 0.5) {
            continue;
          }
          paths.push(rectPath(object.rect));
        }
      }
    } catch {
      // A backend that cannot read the page still lets the reader measure, unsnapped.
    }
    this.snapCache.set(page, { documentId: document.id, paths });
    this.notify();
  }

  // ---- results --------------------------------------------------------------------------------

  /** Every measurement in the active document, page by page. */
  rows(): ResultRow[] {
    const document = this.annotations.activeDocument();
    if (!document) return [];
    return resultRows(
      document.state.pages.map((p) => ({ id: p.id, label: p.label })),
      (pageId) => document.annotations(pageId as ModelId),
    );
  }

  totals(): ResultTotal[] {
    return resultTotals(this.rows());
  }

  /** Loads every page's annotations, so the list is the whole document rather than what is open. */
  async loadAll(): Promise<void> {
    const document = this.annotations.activeDocument();
    if (!document) return;
    for (const [index] of document.state.pages.entries()) {
      await this.annotations.ensurePage(document, index);
    }
    this.notify();
  }

  /** Puts the results on the clipboard as tab-separated text. */
  async copyResults(): Promise<number> {
    const rows = this.rows();
    if (rows.length === 0 || !hasBridge()) return 0;
    await invoke('clipboard:write', { text: rowsToText(rows) });
    this.shell.toasts.show({
      kind: 'success',
      text: `Copied ${String(rows.length)} measurements`,
    });
    return rows.length;
  }

  /** Writes the results as CSV. */
  async exportResults(): Promise<string | null> {
    const rows = this.rows();
    if (rows.length === 0 || !hasBridge()) return null;
    const path = await invoke('file:saveAsDialog', {
      title: 'Export measurements',
      buttonLabel: 'Export',
      defaultPath: 'measurements.csv',
      filters: [{ name: 'Comma-separated values', extensions: ['csv'] }],
    });
    if (!path) return null;
    await invoke('file:write', path, csvBytes(rows));
    this.shell.toasts.show({
      kind: 'success',
      text: `Exported ${String(rows.length)} measurements`,
    });
    return path;
  }

  /** Shows a measurement: selects it and brings its page into view. */
  reveal(id: ModelId): void {
    const document = this.annotations.activeDocument();
    const a = document?.annotation(id);
    if (!document || !a) return;
    const page = document.pageIndex(a.pageId);
    if (page >= 0) this.annotations.activeViewer()?.goToPage(page);
    this.annotations.select([id]);
  }

  // ---- keeping a measurement honest -------------------------------------------------------------

  /**
   * After any change to one of ours: the caption and the `/Rect` follow the geometry.
   *
   * Guarded against itself — the patch it makes is another change, which would arrive here again
   * — and it writes nothing when the text is already right, so a move that does not alter the
   * value costs one comparison.
   */
  async afterChange(a: ModelAnnotation): Promise<void> {
    if (this.rewriting || !isMeasureAnnotation(a) || a.family !== 'shape') return;
    if (!this.settingsValue.writeContents) return;
    const measurement = measurementFor(a);
    if (!measurement || a.contents === measurement.text) return;
    this.rewriting = true;
    try {
      await this.annotations.patch(a.id, { contents: measurement.text });
    } finally {
      this.rewriting = false;
    }
  }

  // ---- plumbing -------------------------------------------------------------------------------

  get shellServices(): ShellServices {
    return this.shell;
  }

  get annotationService(): AnnotationService {
    return this.annotations;
  }

  hasRegistry(name: string): boolean {
    return this.registry.hasService(name);
  }

  /** The scale a new document starts with, and the default `/Measure` of a measurement. */
  get defaultScale(): MeasureScale {
    return this.settingsValue.scale ?? DEFAULT_MEASURE_SCALE;
  }

  dispose(): void {
    this.listeners.clear();
    this.snapCache.clear();
    this.liveValue = null;
    this.snapValue = null;
  }
}
