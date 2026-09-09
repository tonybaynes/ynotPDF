/**
 * M31 manifest — shapes, ink and the eraser, stamps, and file attachments.
 *
 * Everything a reader can do here is a registered command, so it is in the command palette, the
 * e2e suite drives it by id rather than by pixel, and M130's shortcut editor can rebind it. The
 * tool commands take arguments as well, so a test (or a batch) can make a shape without a
 * pointer: `{ page, rect }` for a box, `{ page, vertices }` for a line or a polygon, `{ page,
 * points }` for a stroke, `{ page, x, y, stamp }` for a stamp. The probes at the bottom are how
 * the acceptance tests read this module out of the running app.
 */

import {
  Circle,
  Cloud,
  Eraser,
  Minus,
  MoveUpRight,
  Paperclip,
  Pencil,
  Pentagon,
  Spline,
  Square,
  SquareDashed,
  Stamp as StampIcon,
  Star,
} from 'lucide';
import { registerIcon } from '@app/icons';
import type { ShellServices } from '@app/services';
import { SERVICE } from '@app/services';
import type { Registry } from '@core/Registry';
import type { ModelId } from '@core/Ids';
import type { EngineClient } from '@engine/EngineClient';
import { defaultAppearanceService, stampRotationOf } from '@engine/appearance';
import { defineModule, type CommandSpec, type ServiceContext } from '@shared/module';
import type { PdfPoint, PdfRect } from '@shared/pdf';
import { XOBJECTS_NAMESPACE, toAppearanceInput } from '@modules/M21-save/plan';
import {
  ANNOTATION_SERVICE,
  type AnnotationService,
} from '@modules/M30-markup-annotations/AnnotationService';
import { registerDrawingCodecs } from './commands';
import {
  DrawingService,
  DRAWING_SERVICE,
  STAMP_PANEL_ID,
  stampEntryId,
  stampEntryLabel,
  type ShapeToolId,
} from './DrawingService';
import { drawnByOverlay, isDrawing } from './overlay';
import { drawingProvider } from './provider';
import { DRAWING_SETTINGS_SCHEMA } from './settings';
import { openStampDialog } from './StampDialog';
import { mountStampPanel } from './StampPanel';
import { drawingTools, TOOL_ID } from './tools';

export { DrawingService, DRAWING_SERVICE, STAMP_PANEL_ID } from './DrawingService';

/*
 * Registered at module scope, not in `activate`: the ribbon is built before manifests are
 * activated, and an icon registered later paints as a placeholder on the first frame.
 */
registerIcon('square', Square);
registerIcon('circle', Circle);
registerIcon('minus', Minus);
registerIcon('move-up-right', MoveUpRight);
registerIcon('pentagon', Pentagon);
registerIcon('spline', Spline);
registerIcon('cloud', Cloud);
registerIcon('square-dashed', SquareDashed);
registerIcon('pencil', Pencil);
registerIcon('eraser', Eraser);
registerIcon('stamp', StampIcon);
registerIcon('paperclip', Paperclip);
registerIcon('star', Star);

let live: DrawingService | null = null;
const lookup = (): DrawingService | null => live;

const service = (ctx: ServiceContext): DrawingService =>
  ctx.service<DrawingService>(DRAWING_SERVICE);

const hasService = (ctx: ServiceContext): boolean =>
  ctx.service<Registry>('registry').hasService(DRAWING_SERVICE);

const open = (ctx: ServiceContext): boolean =>
  hasService(ctx) && service(ctx).annotationService.activeDocument() !== null;

function toolIs(id: string): (ctx: ServiceContext) => boolean {
  return (ctx) =>
    ctx.service<{ get(): { activeTool: string | null } }>('ui').get().activeTool === id;
}

function activateTool(ctx: ServiceContext, id: string): void {
  ctx.service<{ activate(id: string): void }>(SERVICE.tools).activate(id);
}

/** A shape command: with arguments it creates straight away; without, it picks up the tool. */
function shapeCommand(spec: {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly keyTip: string;
  readonly tool: ShapeToolId;
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
      if (typeof page === 'number') {
        const rect = asRect(ctx.args['rect']);
        const vertices = asPoints(ctx.args['vertices']);
        if (rect || vertices.length > 0) {
          return await s.createShape(spec.tool, page, {
            ...(rect ? { rect } : {}),
            ...(vertices.length > 0 ? { vertices } : {}),
          });
        }
      }
      activateTool(ctx, TOOL_ID[spec.tool]);
      return null;
    },
  };
}

export default defineModule({
  id: 'M31',
  name: 'Drawing',

  activate(ctx) {
    const registry = ctx.service<Registry>('registry');
    if (registry.hasService(DRAWING_SERVICE)) return undefined;
    if (!registry.hasService(ANNOTATION_SERVICE)) return undefined;
    const shell = registry.service<ShellServices>('shellServices');
    const client = registry.service<EngineClient>('engineClient');
    const annotations = registry.service<AnnotationService>(ANNOTATION_SERVICE);
    registerDrawingCodecs();
    const drawing = new DrawingService({
      registry,
      shell,
      engine: client.engine,
      client,
      annotations,
    });
    live = drawing;
    registry.provide(DRAWING_SERVICE, drawing);
    const unregister = annotations.registerProvider(drawingProvider(drawing));
    void drawing.load();
    return () => {
      live = null;
      unregister();
      drawing.dispose();
    };
  },

  tools: drawingTools(lookup),

  settings: DRAWING_SETTINGS_SCHEMA,

  panels: [
    {
      id: STAMP_PANEL_ID,
      title: 'Stamps',
      dock: 'left',
      icon: 'stamp',
      order: 60,
      toggleCommand: 'draw.stamps',
      mount: (element, context) => mountStampPanel(element, service(context)),
    },
  ],

  commands: [
    // ---- shapes ---------------------------------------------------------------------------------
    shapeCommand({
      id: 'draw.rectangle',
      label: 'Rectangle',
      icon: 'square',
      keyTip: 'DR',
      tool: 'rectangle',
      description: 'Draw a rectangle; hold Shift for a square',
    }),
    shapeCommand({
      id: 'draw.ellipse',
      label: 'Oval',
      icon: 'circle',
      keyTip: 'DO',
      tool: 'ellipse',
      description: 'Draw an oval; hold Shift for a circle',
    }),
    shapeCommand({
      id: 'draw.line',
      label: 'Line',
      icon: 'minus',
      keyTip: 'DL',
      tool: 'line',
      description: 'Draw a straight line; hold Shift to keep it to 45°',
    }),
    shapeCommand({
      id: 'draw.arrow',
      label: 'Arrow',
      icon: 'move-up-right',
      keyTip: 'DA',
      tool: 'arrow',
      description: 'Draw a line with an arrow head at its end',
    }),
    shapeCommand({
      id: 'draw.polygon',
      label: 'Polygon',
      icon: 'pentagon',
      keyTip: 'DG',
      tool: 'polygon',
      description: 'Click each corner; click the first corner again or press Enter to close it',
    }),
    shapeCommand({
      id: 'draw.polyline',
      label: 'Polyline',
      icon: 'spline',
      keyTip: 'DY',
      tool: 'polyline',
      description: 'Click each corner; double-click or press Enter to finish',
    }),
    shapeCommand({
      id: 'draw.cloud',
      label: 'Cloud',
      icon: 'cloud',
      keyTip: 'DC',
      tool: 'cloud',
      description: 'A polygon with a cloudy border; click each corner and close it',
    }),
    shapeCommand({
      id: 'draw.areaHighlight',
      label: 'Area Highlight',
      icon: 'square-dashed',
      keyTip: 'DH',
      tool: 'areaHighlight',
      description: 'Highlight a rectangle of the page, words or not',
    }),

    // ---- the pencil and the eraser --------------------------------------------------------------
    {
      id: 'draw.pencil',
      label: 'Pencil',
      category: 'Comment',
      icon: 'pencil',
      keyTip: 'DP',
      // Not `Mod+Alt+P`: M11 binds that to the page-fit toggle, and last-binding-wins.
      shortcut: 'Mod+Alt+D',
      description: 'Draw freehand; strokes drawn together become one annotation',
      permission: 'annotate',
      when: open,
      run: async (ctx) => {
        const s = service(ctx);
        const page = ctx.args['page'];
        const points = asPoints(ctx.args['points']);
        if (typeof page === 'number' && points.length > 0) {
          const pressures = asNumbers(ctx.args['pressures']);
          return await s.addInkStroke(
            page,
            points,
            pressures.length === points.length ? pressures : null,
          );
        }
        activateTool(ctx, TOOL_ID.pencil);
        return null;
      },
    },
    {
      id: 'draw.pencilEndGroup',
      label: 'End Pencil Group',
      category: 'Comment',
      hidden: true,
      description: 'Internal: the next pencil stroke starts a new annotation',
      when: hasService,
      run: (ctx) => {
        service(ctx).endInkGroup();
      },
    },
    {
      id: 'draw.eraser',
      label: 'Eraser',
      category: 'Comment',
      icon: 'eraser',
      keyTip: 'DE',
      shortcut: 'Mod+Alt+E',
      description: 'Rub out pencil strokes — cut them, or remove them whole',
      permission: 'annotate',
      when: open,
      run: async (ctx) => {
        const s = service(ctx);
        const page = ctx.args['page'];
        const x = ctx.args['x'];
        const y = ctx.args['y'];
        if (typeof page === 'number' && typeof x === 'number' && typeof y === 'number') {
          const radius = ctx.args['radius'];
          return await s.erase(page, { x, y }, typeof radius === 'number' ? radius : undefined);
        }
        activateTool(ctx, TOOL_ID.eraser);
        return null;
      },
    },
    {
      id: 'draw.eraserMode',
      label: 'Eraser Mode',
      category: 'Comment',
      description: 'Whether the eraser cuts a stroke where it passes or removes the whole stroke',
      when: hasService,
      run: async (ctx) => {
        const s = service(ctx);
        const mode = ctx.args['mode'];
        const next =
          mode === 'stroke' || mode === 'split'
            ? mode
            : s.settings.eraserMode === 'split'
              ? 'stroke'
              : 'split';
        await s.setSetting('eraserMode', next);
        return next;
      },
    },
    {
      id: 'draw.inkGroup',
      label: 'Group Pencil Strokes',
      category: 'Comment',
      description: 'Strokes drawn close together become one annotation',
      when: hasService,
      run: async (ctx) => {
        const s = service(ctx);
        const on =
          typeof ctx.args['on'] === 'boolean' ? ctx.args['on'] : !s.settings.inkGroupStrokes;
        await s.setSetting('inkGroupStrokes', on);
        return on;
      },
    },

    // ---- stamps ---------------------------------------------------------------------------------
    {
      id: 'draw.stamp',
      label: 'Stamp',
      category: 'Comment',
      icon: 'stamp',
      keyTip: 'DS',
      shortcut: 'Mod+Alt+S',
      description: 'Place the current stamp; click the page, or drag to size it',
      permission: 'annotate',
      when: open,
      run: async (ctx) => {
        const s = service(ctx);
        const stampId = typeof ctx.args['stamp'] === 'string' ? ctx.args['stamp'] : null;
        if (stampId) await s.setDefaults('stamp', { stampId });
        const page = ctx.args['page'];
        const rect = asRect(ctx.args['rect']);
        const x = ctx.args['x'];
        const y = ctx.args['y'];
        const rotate = typeof ctx.args['rotate'] === 'number' ? ctx.args['rotate'] : 0;
        if (
          typeof page === 'number' &&
          (rect || (typeof x === 'number' && typeof y === 'number'))
        ) {
          const at: PdfPoint | PdfRect = rect ?? { x: x as number, y: y as number };
          return await s.placeStamp(stampId ?? s.defaults('stamp').stampId, page, at, rotate);
        }
        activateTool(ctx, TOOL_ID.stamp);
        return null;
      },
    },
    {
      id: 'draw.stamps',
      label: 'Stamps Panel',
      category: 'View',
      icon: 'stamp',
      description: 'Show or hide the stamp palette',
      run: (ctx) => {
        ctx.service<{ toggle(id: string): void }>(SERVICE.panels).toggle(STAMP_PANEL_ID);
      },
    },
    {
      id: 'draw.stampRotate',
      label: 'Turn Stamp',
      category: 'Comment',
      description: 'Turn the selected stamp to an angle, in degrees anticlockwise',
      permission: 'annotate',
      when: (ctx) => hasService(ctx) && service(ctx).annotationService.selection.length > 0,
      run: async (ctx) => {
        const s = service(ctx);
        const id = (ctx.args['id'] as ModelId | undefined) ?? s.annotationService.selection[0];
        const degrees = ctx.args['degrees'];
        if (!id || typeof degrees !== 'number') return false;
        return await s.setStampRotation(id, degrees);
      },
    },
    {
      id: 'draw.stampFavourite',
      label: 'Favourite Stamp',
      category: 'Comment',
      icon: 'star',
      description: 'Star or unstar a stamp in the palette',
      when: hasService,
      run: async (ctx) => {
        const s = service(ctx);
        const id =
          typeof ctx.args['stamp'] === 'string' ? ctx.args['stamp'] : s.defaults('stamp').stampId;
        return await s.toggleFavourite(id);
      },
    },
    {
      id: 'draw.stampCustom',
      label: 'Custom Stamp…',
      category: 'Comment',
      icon: 'stamp',
      keyTip: 'DU',
      description: 'Make a stamp from a picture, the clipboard or a PDF page',
      when: hasService,
      run: async (ctx) => {
        const s = service(ctx);
        const png = ctx.args['png'];
        const width = ctx.args['width'];
        const height = ctx.args['height'];
        if (Array.isArray(png) && typeof width === 'number' && typeof height === 'number') {
          const stamp = await s.addCustomStamp({
            label: typeof ctx.args['label'] === 'string' ? ctx.args['label'] : 'Custom stamp',
            png: Uint8Array.from(png.filter((n): n is number => typeof n === 'number')),
            width,
            height,
          });
          await s.setDefaults('stamp', { stampId: stamp.id });
          return stamp.id;
        }
        return await openStampDialog(s);
      },
    },
    {
      id: 'draw.stampRemove',
      label: 'Remove Custom Stamp',
      category: 'Comment',
      description: 'Remove a custom stamp from the palette (placed copies stay in their documents)',
      when: hasService,
      run: async (ctx) => {
        const s = service(ctx);
        const id =
          typeof ctx.args['stamp'] === 'string' ? ctx.args['stamp'] : s.defaults('stamp').stampId;
        const entry = s.stampEntry(id);
        if (entry?.kind !== 'custom') return false;
        if (ctx.args['confirm'] === true) {
          const yes = await s.shellServices.dialogs.confirm({
            title: 'Remove stamp',
            text: `Remove the custom stamp "${entry.stamp.label}" from the palette? Copies already placed in documents are kept.`,
            confirmLabel: 'Remove',
            danger: true,
          });
          if (!yes) return false;
        }
        return await s.removeCustomStamp(id);
      },
    },
    {
      id: 'draw.stampRename',
      label: 'Rename Custom Stamp',
      category: 'Comment',
      description: 'Give a custom stamp another name',
      when: hasService,
      run: async (ctx) => {
        const s = service(ctx);
        const id =
          typeof ctx.args['stamp'] === 'string' ? ctx.args['stamp'] : s.defaults('stamp').stampId;
        const entry = s.stampEntry(id);
        if (entry?.kind !== 'custom') return false;
        const label =
          typeof ctx.args['label'] === 'string'
            ? ctx.args['label']
            : await s.shellServices.dialogs.prompt({
                title: 'Rename stamp',
                label: 'Name',
                value: entry.stamp.label,
              });
        if (label === null) return false;
        return await s.renameCustomStamp(id, label);
      },
    },

    // ---- attachments ----------------------------------------------------------------------------
    {
      id: 'draw.attachFile',
      label: 'Attach File',
      category: 'Comment',
      icon: 'paperclip',
      keyTip: 'DF',
      description: 'Pin a file to the page; click where the pin should go',
      permission: 'annotate',
      when: open,
      run: async (ctx) => {
        const s = service(ctx);
        const page = ctx.args['page'];
        const x = ctx.args['x'];
        const y = ctx.args['y'];
        const file = asFile(ctx.args['file']);
        if (typeof page === 'number' && typeof x === 'number' && typeof y === 'number') {
          return await s.attachFile(page, { x, y }, file ?? undefined);
        }
        activateTool(ctx, TOOL_ID.attachFile);
        return null;
      },
    },

    // ---- developer probes (the acceptance tests read the app through these) -----------------
    {
      id: 'dev.drawing',
      label: 'Drawing state',
      category: 'Developer',
      hidden: true,
      description: 'Internal: the drawing settings, defaults and stamps',
      when: hasService,
      run: (ctx) => {
        const s = service(ctx);
        const tool = typeof ctx.args['tool'] === 'string' ? ctx.args['tool'] : 'rectangle';
        return {
          settings: s.settings,
          defaults: s.defaults(tool as never),
          stamps: s.allStamps().map((e) => ({
            id: stampEntryId(e),
            label: stampEntryLabel(e),
            kind: e.kind,
            favourite: s.isFavourite(stampEntryId(e)),
          })),
          xobjects: Object.keys(
            s.annotationService.activeDocument()?.custom(XOBJECTS_NAMESPACE) ?? {},
          ),
        };
      },
    },
    {
      id: 'dev.drawings',
      label: 'Drawings on a page',
      category: 'Developer',
      hidden: true,
      description: 'Internal: M31’s annotations on a page, with what the overlay does for them',
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
          .filter(isDrawing)
          .map((a) => {
            const stream = defaultAppearanceService.generate(toAppearanceInput(a));
            return {
              id: String(a.id),
              subtype: a.subtype,
              family: a.family,
              rect: a.rect,
              color: a.color,
              interiorColor: a.interiorColor,
              borderWidth: a.borderWidth,
              contents: a.contents,
              subject: a.subject,
              vertices: 'vertices' in a ? [...a.vertices] : [],
              paths: 'paths' in a ? a.paths.map((p) => p.length) : [],
              rotate: stampRotationOf(a.extra),
              extra: a.extra,
              drawnByOverlay: drawnByOverlay(a, new Set()),
              appearance: stream
                ? {
                    content: stream.content,
                    bbox: stream.bbox,
                    xobjects: stream.resources.xobjects ?? {},
                  }
                : null,
            };
          });
      },
    },
  ],

  shortcuts: [],

  /*
   * Three groups on the Comment tab, after M30's four, in Foxit's own order: the shapes, the
   * freehand tools, and the stamps with the attachment. Each is kept to six controls — the
   * ribbon collapses a group that does not fit (the lesson M13 recorded).
   */
  ribbon: [
    {
      id: 'comment.shapes',
      tab: 'comment',
      label: 'Shapes',
      order: 25,
      items: [
        { kind: 'toggle', command: 'draw.rectangle', pressed: toolIs(TOOL_ID.rectangle) },
        { kind: 'toggle', command: 'draw.ellipse', pressed: toolIs(TOOL_ID.ellipse) },
        { kind: 'toggle', command: 'draw.line', pressed: toolIs(TOOL_ID.line) },
        { kind: 'toggle', command: 'draw.arrow', pressed: toolIs(TOOL_ID.arrow) },
        { kind: 'toggle', command: 'draw.polygon', pressed: toolIs(TOOL_ID.polygon) },
        { kind: 'toggle', command: 'draw.polyline', pressed: toolIs(TOOL_ID.polyline) },
      ],
    },
    {
      id: 'comment.draw',
      tab: 'comment',
      label: 'Draw',
      order: 26,
      items: [
        { kind: 'toggle', command: 'draw.cloud', pressed: toolIs(TOOL_ID.cloud) },
        { kind: 'toggle', command: 'draw.areaHighlight', pressed: toolIs(TOOL_ID.areaHighlight) },
        { kind: 'toggle', command: 'draw.pencil', pressed: toolIs(TOOL_ID.pencil) },
        { kind: 'toggle', command: 'draw.eraser', pressed: toolIs(TOOL_ID.eraser) },
      ],
      large: ['draw.pencil'],
    },
    {
      id: 'comment.stamps',
      tab: 'comment',
      label: 'Stamps',
      order: 27,
      items: [
        {
          kind: 'split',
          command: 'draw.stamp',
          menu: () => {
            const s = live;
            if (!s) return [];
            const items: Array<
              { label: string; command: string; args: Record<string, unknown> } | '-'
            > = [];
            const favourites = s.allStamps().filter((e) => s.isFavourite(stampEntryId(e)));
            for (const e of favourites) {
              items.push({
                label: `★ ${stampEntryLabel(e)}`,
                command: 'draw.stamp',
                args: { stamp: stampEntryId(e) },
              });
            }
            if (favourites.length > 0) items.push('-');
            for (const category of s.catalogue.categories) {
              for (const e of s.allStamps()) {
                if (e.kind === 'catalogue' && e.definition.category === category.id) {
                  items.push({
                    label: stampEntryLabel(e),
                    command: 'draw.stamp',
                    args: { stamp: stampEntryId(e) },
                  });
                }
              }
              items.push('-');
            }
            for (const e of s.allStamps()) {
              if (e.kind === 'custom') {
                items.push({
                  label: stampEntryLabel(e),
                  command: 'draw.stamp',
                  args: { stamp: stampEntryId(e) },
                });
              }
            }
            return items;
          },
          size: 'large',
        },
        'draw.stampCustom',
        'draw.stamps',
        { kind: 'toggle', command: 'draw.attachFile', pressed: toolIs(TOOL_ID.attachFile) },
      ],
    },
  ],

  contextMenus: [
    {
      id: 'm31.drawMenu',
      region: '.viewer-scroll',
      order: 5,
      items: ['draw.stamp', 'draw.attachFile', 'draw.stampRotate'],
    },
  ],
});

// ---- helpers ---------------------------------------------------------------------------------

function asRect(value: unknown): PdfRect | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (!['x0', 'y0', 'x1', 'y1'].every((k) => typeof r[k] === 'number')) return null;
  const x0 = r['x0'] as number;
  const y0 = r['y0'] as number;
  const x1 = r['x1'] as number;
  const y1 = r['y1'] as number;
  return { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
}

function asPoints(value: unknown): PdfPoint[] {
  if (!Array.isArray(value)) return [];
  const out: PdfPoint[] = [];
  for (const p of value) {
    if (!p || typeof p !== 'object') continue;
    const q = p as Record<string, unknown>;
    if (typeof q['x'] === 'number' && typeof q['y'] === 'number')
      out.push({ x: q['x'], y: q['y'] });
  }
  return out;
}

function asNumbers(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((n): n is number => typeof n === 'number') : [];
}

function asFile(value: unknown): { name: string; bytes: Uint8Array; description?: string } | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (typeof r['name'] !== 'string' || !Array.isArray(r['bytes'])) return null;
  return {
    name: r['name'],
    bytes: Uint8Array.from(r['bytes'].filter((n): n is number => typeof n === 'number')),
    ...(typeof r['description'] === 'string' ? { description: r['description'] } : {}),
  };
}
