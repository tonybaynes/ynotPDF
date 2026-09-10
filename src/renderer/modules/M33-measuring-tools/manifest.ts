/**
 * M33 manifest — the measuring tools: distance, perimeter, area, calibration and the results.
 *
 * Everything a reader can do here is a registered command, so it is in the command palette, the
 * e2e suite drives it by id rather than by pixel, and M130's shortcut editor can rebind it. The
 * tool commands take arguments too, so a test (or a batch) can measure without a pointer:
 * `{ page, vertices }` for any of the three, `{ page, from, to, length, unit }` for a
 * calibration. The probes at the bottom are how the acceptance tests read this module out of the
 * running app.
 */

import { Copy, Download, Ruler, RulerDimensionLine, Scaling, Spline, SquareDashed } from 'lucide';
import { registerIcon } from '@app/icons';
import type { ShellServices } from '@app/services';
import { SERVICE } from '@app/services';
import type { Registry } from '@core/Registry';
import type { ModelId } from '@core/Ids';
import type { EngineClient } from '@engine/EngineClient';
import {
  defaultAppearanceService,
  isMeasureUnit,
  measurementOf,
  normaliseScale,
  parseMeasureScale,
  scaleRatioText,
  type MeasureUnit,
} from '@engine/appearance';
import { defineModule, type CommandSpec, type ServiceContext } from '@shared/module';
import type { PdfPoint } from '@shared/pdf';
import { toAppearanceInput } from '@modules/M21-save/plan';
import {
  ANNOTATION_SERVICE,
  type AnnotationService,
} from '@modules/M30-markup-annotations/AnnotationService';
import { openCalibrateDialog } from './CalibrateDialog';
import {
  MeasureService,
  MEASURE_SERVICE,
  RESULTS_PANEL_ID,
  type MeasuringToolId,
} from './MeasureService';
import { drawnByOverlay, isMeasureAnnotation, measurementFor } from './overlay';
import { measureProvider } from './provider';
import { mountResultsPanel } from './ResultsPanel';
import { MEASURE_SETTINGS_SCHEMA, SNAP_LABELS, SNAP_SETTING, SNAP_KINDS } from './settings';
import { measuringTools, TOOL_ID } from './tools';

export { MeasureService, MEASURE_SERVICE, RESULTS_PANEL_ID } from './MeasureService';

/*
 * Registered at module scope, not in `activate`: the ribbon is built before manifests are
 * activated, and an icon registered later paints as a placeholder on the first frame.
 */
registerIcon('ruler', Ruler);
registerIcon('ruler-dimension-line', RulerDimensionLine);
registerIcon('scaling', Scaling);
registerIcon('spline', Spline);
registerIcon('square-dashed', SquareDashed);
registerIcon('copy', Copy);
registerIcon('download', Download);

let live: MeasureService | null = null;
const lookup = (): MeasureService | null => live;

const service = (ctx: ServiceContext): MeasureService =>
  ctx.service<MeasureService>(MEASURE_SERVICE);

const hasService = (ctx: ServiceContext): boolean =>
  ctx.service<Registry>('registry').hasService(MEASURE_SERVICE);

const open = (ctx: ServiceContext): boolean =>
  hasService(ctx) && service(ctx).annotationService.activeDocument() !== null;

function toolIs(id: string): (ctx: ServiceContext) => boolean {
  return (ctx) =>
    ctx.service<{ get(): { activeTool: string | null } }>('ui').get().activeTool === id;
}

function activateTool(ctx: ServiceContext, id: string): void {
  ctx.service<{ activate(id: string): void }>(SERVICE.tools).activate(id);
}

/** A measuring command: with arguments it measures straight away; without, it picks up the tool. */
function measureCommand(spec: {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly keyTip: string;
  readonly tool: MeasuringToolId;
  readonly description: string;
  readonly shortcut?: string;
}): CommandSpec {
  return {
    id: spec.id,
    label: spec.label,
    category: 'Comment',
    icon: spec.icon,
    keyTip: spec.keyTip,
    ...(spec.shortcut ? { shortcut: spec.shortcut } : {}),
    description: spec.description,
    permission: 'annotate',
    when: open,
    run: async (ctx) => {
      const s = service(ctx);
      const page = ctx.args['page'];
      const vertices = asPoints(ctx.args['vertices']);
      if (typeof page === 'number' && vertices.length >= 2) {
        return await s.createMeasurement(spec.tool, page, vertices);
      }
      activateTool(ctx, TOOL_ID[spec.tool]);
      return null;
    },
  };
}

export default defineModule({
  id: 'M33',
  name: 'Measuring',

  activate(ctx) {
    const registry = ctx.service<Registry>('registry');
    if (registry.hasService(MEASURE_SERVICE)) return undefined;
    if (!registry.hasService(ANNOTATION_SERVICE)) return undefined;
    const shell = registry.service<ShellServices>('shellServices');
    const client = registry.service<EngineClient>('engineClient');
    const annotations = registry.service<AnnotationService>(ANNOTATION_SERVICE);
    const measure = new MeasureService({
      registry,
      shell,
      engine: client.engine,
      annotations,
    });
    live = measure;
    registry.provide(MEASURE_SERVICE, measure);
    const unregister = annotations.registerProvider(measureProvider(measure));
    void measure.load();
    return () => {
      live = null;
      unregister();
      measure.dispose();
    };
  },

  tools: measuringTools(lookup),

  settings: MEASURE_SETTINGS_SCHEMA,

  panels: [
    {
      id: RESULTS_PANEL_ID,
      title: 'Measurements',
      dock: 'left',
      icon: 'ruler',
      order: 70,
      toggleCommand: 'measure.results',
      mount: (element, context) => mountResultsPanel(element, service(context)),
    },
  ],

  commands: [
    // ---- the three tools ------------------------------------------------------------------------
    measureCommand({
      id: 'measure.distance',
      label: 'Distance',
      icon: 'ruler',
      keyTip: 'MD',
      tool: 'distance',
      shortcut: 'Mod+Alt+L',
      description: 'Measure between two points; hold Shift to keep the line to 45°',
    }),
    measureCommand({
      id: 'measure.perimeter',
      label: 'Perimeter',
      icon: 'spline',
      keyTip: 'MP',
      tool: 'perimeter',
      description: 'Measure along a run of segments; click each corner, Enter to finish',
    }),
    measureCommand({
      id: 'measure.area',
      label: 'Area',
      icon: 'square-dashed',
      keyTip: 'MA',
      tool: 'area',
      shortcut: 'Mod+Alt+A',
      description: 'Measure an enclosed area; click each corner and close the shape',
    }),

    // ---- calibration and the scale --------------------------------------------------------------
    {
      id: 'measure.calibrate',
      label: 'Calibrate',
      category: 'Comment',
      icon: 'ruler-dimension-line',
      keyTip: 'MC',
      description: 'Draw a line whose real length you know, and set the scale from it',
      permission: 'annotate',
      when: open,
      run: async (ctx) => {
        const s = service(ctx);
        const page = ctx.args['page'];
        const from = asPoint(ctx.args['from']);
        const to = asPoint(ctx.args['to']);
        if (typeof page !== 'number' || !from || !to) {
          activateTool(ctx, TOOL_ID.calibrate);
          return null;
        }
        const length = ctx.args['length'];
        const unit = ctx.args['unit'];
        // Driven with a length: no dialog, which is what a test and a batch run need.
        if (typeof length === 'number' && isMeasureUnit(unit)) {
          const scope = ctx.args['scope'] === 'document' ? 'document' : 'page';
          const scale = await s.calibrate({
            page,
            from,
            to,
            realValue: length,
            unit,
            ...(typeof ctx.args['precision'] === 'number'
              ? { precision: ctx.args['precision'] }
              : {}),
            scope,
          });
          return scale ? scaleRatioText(scale) : null;
        }
        const pagePoints = Math.hypot(to.x - from.x, to.y - from.y);
        const chosen = await openCalibrateDialog(s, { page, pagePoints });
        if (!chosen) return null;
        const ok = await s.setScale(chosen.scale, { page, scope: chosen.scope });
        return ok ? scaleRatioText(chosen.scale) : null;
      },
    },
    {
      id: 'measure.scale',
      label: 'Measurement Scale…',
      category: 'Comment',
      icon: 'scaling',
      keyTip: 'MS',
      description: 'Set the ratio between the page and the real world, by hand',
      when: open,
      run: async (ctx) => {
        const s = service(ctx);
        const page =
          typeof ctx.args['page'] === 'number'
            ? ctx.args['page']
            : (s.annotationService.activeViewer()?.state.page ?? 0);
        const given = parseMeasureScale(ctx.args['scale']);
        if (given) {
          const scope = ctx.args['scope'] === 'page' ? 'page' : 'document';
          const ok = await s.setScale(given, { page, scope });
          return ok ? scaleRatioText(given) : null;
        }
        const chosen = await openCalibrateDialog(s, { page });
        if (!chosen) return null;
        const ok = await s.setScale(chosen.scale, { page, scope: chosen.scope });
        return ok ? scaleRatioText(chosen.scale) : null;
      },
    },
    {
      id: 'measure.clearPageScale',
      label: 'Use the Document Scale on This Page',
      category: 'Comment',
      description: 'Drops this page’s own calibration, so it measures like the rest again',
      when: (ctx) => {
        if (!open(ctx)) return false;
        const s = service(ctx);
        return s.pageIsCalibrated(s.annotationService.activeViewer()?.state.page ?? 0);
      },
      run: async (ctx) => {
        const s = service(ctx);
        const page =
          typeof ctx.args['page'] === 'number'
            ? ctx.args['page']
            : (s.annotationService.activeViewer()?.state.page ?? 0);
        return await s.clearPageScale(page);
      },
    },

    // ---- snapping --------------------------------------------------------------------------------
    {
      id: 'measure.snap',
      label: 'Snap While Measuring',
      category: 'Comment',
      icon: 'ruler',
      description: 'Whether a measurement jumps to what is drawn on the page',
      when: hasService,
      run: async (ctx) => {
        const s = service(ctx);
        const on = typeof ctx.args['on'] === 'boolean' ? ctx.args['on'] : !s.settings.snap;
        await s.setSetting('snap', on);
        return on;
      },
    },
    {
      id: 'measure.snapKind',
      label: 'Snap To…',
      category: 'Comment',
      description: 'Turn one kind of snap on or off: endpoints, midpoints, intersections, paths',
      when: hasService,
      run: async (ctx) => {
        const s = service(ctx);
        const kind = ctx.args['kind'];
        const found = SNAP_KINDS.find((k) => k === kind);
        if (!found) return null;
        const key = SNAP_SETTING[found];
        const current = s.settings[key];
        const on = typeof ctx.args['on'] === 'boolean' ? ctx.args['on'] : !(current === true);
        await s.setSetting(key, on);
        return { kind: found, label: SNAP_LABELS[found], on };
      },
    },

    // ---- the results -----------------------------------------------------------------------------
    {
      id: 'measure.results',
      label: 'Measurements Panel',
      category: 'View',
      icon: 'ruler',
      description: 'Show or hide the list of measurements',
      run: (ctx) => {
        ctx.service<{ toggle(id: string): void }>(SERVICE.panels).toggle(RESULTS_PANEL_ID);
      },
    },
    {
      id: 'measure.copy',
      label: 'Copy Measurements',
      category: 'Comment',
      icon: 'copy',
      description: 'Put every measurement on the clipboard, one per line',
      when: open,
      run: async (ctx) => await service(ctx).copyResults(),
    },
    {
      id: 'measure.export',
      label: 'Export Measurements…',
      category: 'Comment',
      icon: 'download',
      description: 'Write every measurement to a CSV file',
      when: open,
      run: async (ctx) => await service(ctx).exportResults(),
    },
    {
      id: 'measure.reveal',
      label: 'Show Measurement',
      category: 'Comment',
      hidden: true,
      description: 'Internal: select a measurement and go to its page',
      when: open,
      run: (ctx) => {
        const id = ctx.args['id'];
        if (typeof id !== 'string') return false;
        service(ctx).reveal(id as ModelId);
        return true;
      },
    },

    // ---- developer probes (the acceptance tests read the app through these) -----------------
    {
      id: 'dev.measure',
      label: 'Measuring state',
      category: 'Developer',
      hidden: true,
      description: 'Internal: the measuring settings, the scale and the results',
      when: hasService,
      run: (ctx) => {
        const s = service(ctx);
        const tool = typeof ctx.args['tool'] === 'string' ? ctx.args['tool'] : 'distance';
        const page = typeof ctx.args['page'] === 'number' ? ctx.args['page'] : 0;
        return {
          settings: s.settings,
          defaults: s.defaults(tool as never),
          scale: normaliseScale(s.scaleFor(page)),
          ratio: s.ratioText(page),
          pageCalibrated: s.pageIsCalibrated(page),
          live: s.live,
          snap: s.snapIndicator,
          rows: s.rows(),
          totals: s.totals(),
        };
      },
    },
    {
      id: 'dev.measurements',
      label: 'Measurements on a page',
      category: 'Developer',
      hidden: true,
      description: 'Internal: M33’s annotations on a page, with what the overlay does for them',
      when: open,
      run: async (ctx) => {
        const s = service(ctx);
        const document = s.annotationService.activeDocument();
        if (!document) return null;
        const page = Number(ctx.args['page'] ?? 0);
        const modelPage = document.state.pages[page];
        if (!modelPage) return null;
        await s.annotationService.ensurePage(document, page);
        return document
          .annotations(modelPage.id)
          .filter(isMeasureAnnotation)
          .map((a) => {
            const stream = defaultAppearanceService.generate(toAppearanceInput(a));
            const measurement =
              measurementFor(a) ??
              measurementOf({ subtype: a.subtype, vertices: [], extra: a.extra });
            return {
              id: String(a.id),
              subtype: a.subtype,
              rect: a.rect,
              color: a.color,
              borderWidth: a.borderWidth,
              contents: a.contents,
              subject: a.subject,
              vertices: 'vertices' in a ? [...a.vertices] : [],
              intent: a.extra['intent'],
              measure: a.extra['measure'],
              value: measurement?.value ?? null,
              text: measurement?.text ?? null,
              extra: a.extra,
              drawnByOverlay: drawnByOverlay(a, new Set()),
              appearance: stream ? { content: stream.content, bbox: stream.bbox } : null,
            };
          });
      },
    },
    {
      id: 'dev.snapPoints',
      label: 'Snap candidates on a page',
      category: 'Developer',
      hidden: true,
      description: 'Internal: what the snapper found for a point',
      when: open,
      run: (ctx) => {
        const s = service(ctx);
        const page = Number(ctx.args['page'] ?? 0);
        const x = Number(ctx.args['x'] ?? 0);
        const y = Number(ctx.args['y'] ?? 0);
        const scale = typeof ctx.args['scale'] === 'number' ? ctx.args['scale'] : 1;
        const paths = s.snapPaths(page);
        const point = s.snap(page, { x, y }, scale);
        return {
          ready: paths !== null,
          paths: paths?.length ?? 0,
          point,
          snapped: s.snapIndicator,
        };
      },
    },
  ],

  shortcuts: [],

  /*
   * One group on the Comment tab, after M31's three, in Foxit's own order: the three measuring
   * tools, then calibration and the panel. Kept to five controls — the ribbon collapses a group
   * that does not fit (the lesson M13 recorded).
   */
  ribbon: [
    {
      id: 'comment.measure',
      tab: 'comment',
      label: 'Measure',
      order: 28,
      items: [
        { kind: 'toggle', command: 'measure.distance', pressed: toolIs(TOOL_ID.distance) },
        { kind: 'toggle', command: 'measure.perimeter', pressed: toolIs(TOOL_ID.perimeter) },
        { kind: 'toggle', command: 'measure.area', pressed: toolIs(TOOL_ID.area) },
        {
          kind: 'split',
          command: 'measure.calibrate',
          menu: () => [
            'measure.scale',
            'measure.clearPageScale',
            '-',
            { label: 'Snap while measuring', command: 'measure.snap' },
            ...SNAP_KINDS.map((kind) => ({
              label: `Snap to ${SNAP_LABELS[kind].toLowerCase()}`,
              command: 'measure.snapKind',
              args: { kind },
              checked: () => live?.settings[SNAP_SETTING[kind]] === true,
            })),
          ],
          size: 'large',
        },
        'measure.results',
      ],
      large: ['measure.distance'],
    },
  ],

  contextMenus: [
    {
      id: 'm33.measureMenu',
      region: '.viewer-scroll',
      order: 6,
      items: ['measure.distance', 'measure.area', 'measure.calibrate'],
    },
  ],
});

// ---- helpers ---------------------------------------------------------------------------------

function asPoint(value: unknown): PdfPoint | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  return typeof r['x'] === 'number' && typeof r['y'] === 'number' ? { x: r['x'], y: r['y'] } : null;
}

function asPoints(value: unknown): PdfPoint[] {
  if (!Array.isArray(value)) return [];
  const out: PdfPoint[] = [];
  for (const item of value) {
    const point = asPoint(item);
    if (point) out.push(point);
  }
  return out;
}

/** Exported for the settings dialog and the tests: the units a scale may name. */
export type { MeasureUnit };
