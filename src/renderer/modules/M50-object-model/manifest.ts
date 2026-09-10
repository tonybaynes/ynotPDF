/**
 * M50 manifest — page objects: select, move, resize, rotate, flip, align, distribute, arrange,
 * group, delete, cut/copy/paste, duplicate, and the properties panel.
 *
 * Every user action is a registered command, so it is in the palette, on a shortcut where one
 * makes sense, and drivable by id from the e2e suite; the ones that take arguments (`object.move`
 * with `{ dx, dy }`, `object.select` with `{ page, ids }`) exist so a test — or a batch — can do
 * without a pointer. The probes at the bottom are how the acceptance tests read this module out
 * of the running app.
 */

import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  Blend,
  BringToFront,
  ClipboardPaste,
  Copy,
  FlipHorizontal2,
  FlipVertical2,
  Group,
  Image as ImageIcon,
  MousePointer2,
  RotateCcw,
  RotateCw,
  Scissors,
  SendToBack,
  Shapes,
  Trash2,
  Type as TypeIcon,
  Ungroup,
} from 'lucide';
import { registerIcon } from '@app/icons';
import type { ShellServices } from '@app/services';
import { SERVICE } from '@app/services';
import type { Registry } from '@core/Registry';
import { defineModule, type CommandSpec, type ServiceContext } from '@shared/module';
import { readObjectsState, OBJECTS_NAMESPACE } from './model';
import { ObjectController } from './ObjectController';
import { OBJECT_PANEL_ID, OBJECT_SERVICE, ObjectService, type ArrangeOp } from './ObjectService';
import { mountObjectPanel } from './PropertiesPanel';
import { OBJECT_SETTINGS_SCHEMA, type ObjectFilter } from './settings';
import { TOOL_ID, objectTools } from './tools';
import type { AlignEdge } from './geometry';
import './object-model.css';

export { OBJECT_SERVICE, OBJECT_PANEL_ID, ObjectService } from './ObjectService';

registerIcon('mouse-pointer-2', MousePointer2);
registerIcon('type', TypeIcon);
registerIcon('image', ImageIcon);
registerIcon('shapes', Shapes);
registerIcon('blend', Blend);
registerIcon('align-start-vertical', AlignStartVertical);
registerIcon('align-center-vertical', AlignCenterVertical);
registerIcon('align-end-vertical', AlignEndVertical);
registerIcon('align-start-horizontal', AlignStartHorizontal);
registerIcon('align-center-horizontal', AlignCenterHorizontal);
registerIcon('align-end-horizontal', AlignEndHorizontal);
registerIcon('align-horizontal-distribute-center', AlignHorizontalDistributeCenter);
registerIcon('align-vertical-distribute-center', AlignVerticalDistributeCenter);
registerIcon('bring-to-front', BringToFront);
registerIcon('send-to-back', SendToBack);
registerIcon('group', Group);
registerIcon('ungroup', Ungroup);
registerIcon('rotate-cw', RotateCw);
registerIcon('rotate-ccw', RotateCcw);
registerIcon('flip-horizontal-2', FlipHorizontal2);
registerIcon('flip-vertical-2', FlipVertical2);
registerIcon('copy', Copy);
registerIcon('clipboard-paste', ClipboardPaste);
registerIcon('scissors', Scissors);
registerIcon('trash-2', Trash2);

let live: ObjectService | null = null;
const lookup = (): ObjectService | null => live;

const service = (ctx: ServiceContext): ObjectService => ctx.service<ObjectService>(OBJECT_SERVICE);

const hasService = (ctx: ServiceContext): boolean =>
  ctx.service<Registry>('registry').hasService(OBJECT_SERVICE);

const open = (ctx: ServiceContext): boolean =>
  hasService(ctx) && service(ctx).activeDocument() !== null;

const selected = (ctx: ServiceContext): boolean =>
  hasService(ctx) && service(ctx).selection.length > 0;

const several = (ctx: ServiceContext): boolean =>
  hasService(ctx) && service(ctx).selection.length > 1;

const three = (ctx: ServiceContext): boolean =>
  hasService(ctx) && service(ctx).selection.length > 2;

function toolIs(id: string): (ctx: ServiceContext) => boolean {
  return (ctx) =>
    ctx.service<{ get(): { activeTool: string | null } }>('ui').get().activeTool === id;
}

function activateTool(ctx: ServiceContext, id: string): void {
  ctx.service<{ activate(id: string): void }>(SERVICE.tools).activate(id);
}

function editCommand(
  filter: ObjectFilter,
  label: string,
  icon: string,
  keyTip: string,
): CommandSpec {
  return {
    id: filter === 'all' ? 'object.edit' : `object.edit.${filter}`,
    label,
    category: 'Edit',
    icon,
    keyTip,
    ...(filter === 'all' ? { shortcut: 'Mod+Shift+O' } : {}),
    description:
      filter === 'all'
        ? 'Select and move, resize, rotate or arrange any object on the page'
        : `Select only ${label.replace('Edit ', '').toLowerCase()} on the page`,
    permission: 'modify',
    when: open,
    run: (ctx) => {
      activateTool(ctx, TOOL_ID[filter]);
    },
  };
}

function alignCommand(edge: AlignEdge, label: string, icon: string): CommandSpec {
  return {
    id: `object.align.${edge}`,
    label: `Align ${label}`,
    category: 'Edit',
    icon,
    description: 'Line the selected objects up on this edge, to the selection or the page',
    permission: 'modify',
    when: selected,
    run: (ctx) => service(ctx).align(edge),
  };
}

function arrangeCommand(op: ArrangeOp, label: string, icon: string, shortcut: string): CommandSpec {
  return {
    id: `object.arrange.${op}`,
    label,
    category: 'Edit',
    icon,
    shortcut,
    description: 'Change where the selected objects sit in the page’s drawing order',
    permission: 'modify',
    when: selected,
    run: (ctx) => service(ctx).arrange(op),
  };
}

function asNumber(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export default defineModule({
  id: 'M50',
  name: 'Page objects',

  activate(ctx) {
    const registry = ctx.service<Registry>('registry');
    if (registry.hasService(OBJECT_SERVICE)) return undefined;
    const shell = ctx.service<ShellServices>('shellServices');
    const created = new ObjectService({ registry, shell });
    live = created;
    registry.provide(OBJECT_SERVICE, created);
    const host = document.querySelector<HTMLElement>('.viewer-host') ?? document.body;
    const controller = new ObjectController({ service: created, shell, host });
    return () => {
      controller.dispose();
      created.dispose();
      live = null;
    };
  },

  tools: objectTools(lookup),

  settings: OBJECT_SETTINGS_SCHEMA,

  panels: [
    {
      id: OBJECT_PANEL_ID,
      title: 'Object',
      dock: 'right',
      icon: 'shapes',
      // Order 0 like M30's: a panel bound to the selection outranks a document-wide one.
      order: 0,
      when: selected,
      mount: (element, context) => mountObjectPanel(element, service(context)),
    },
  ],

  commands: [
    editCommand('all', 'Edit Object', 'mouse-pointer-2', 'EO'),
    editCommand('text', 'Edit Text Objects', 'type', 'ET'),
    editCommand('image', 'Edit Image Objects', 'image', 'EI'),
    editCommand('path', 'Edit Shape Objects', 'shapes', 'ES'),
    editCommand('shading', 'Edit Shading Objects', 'blend', 'EH'),

    {
      id: 'object.selectAll',
      label: 'Select All Objects',
      category: 'Edit',
      description: 'Select every object on the current page the tool can pick up',
      when: open,
      run: async (ctx) => {
        const page = ctx.args['page'];
        await service(ctx).selectAll(typeof page === 'number' ? page : undefined);
      },
    },
    {
      id: 'object.select',
      label: 'Select Objects',
      category: 'Edit',
      hidden: true,
      description: 'Internal: select objects by id on a page',
      when: open,
      run: async (ctx) => {
        const page = asNumber(ctx.args['page']);
        const ids = Array.isArray(ctx.args['ids'])
          ? ctx.args['ids'].filter((s): s is string => typeof s === 'string')
          : [];
        const s = service(ctx);
        await s.ensurePage(page);
        s.select(page, ids, ctx.args['additive'] === true);
        return s.selection;
      },
    },
    {
      id: 'object.selectAt',
      label: 'Select Object At Point',
      category: 'Edit',
      hidden: true,
      description: 'Internal: select the object under a page point',
      when: open,
      run: async (ctx) => {
        const s = service(ctx);
        return await s.selectAt(
          asNumber(ctx.args['page']),
          { x: asNumber(ctx.args['x']), y: asNumber(ctx.args['y']) },
          ctx.args['additive'] === true,
        );
      },
    },
    {
      id: 'object.deselect',
      label: 'Deselect Objects',
      category: 'Edit',
      description: 'Clear the object selection',
      when: selected,
      run: (ctx) => {
        service(ctx).deselect();
      },
    },
    {
      id: 'object.delete',
      label: 'Delete Object',
      category: 'Edit',
      icon: 'trash-2',
      description: 'Remove the selected objects from the page',
      permission: 'modify',
      when: selected,
      run: (ctx) => service(ctx).remove(),
    },
    {
      id: 'object.cut',
      label: 'Cut Object',
      category: 'Edit',
      icon: 'scissors',
      description: 'Copy the selected objects to the clipboard and remove them',
      permission: 'modify',
      when: selected,
      run: (ctx) => service(ctx).cut(),
    },
    {
      id: 'object.copy',
      label: 'Copy Object',
      category: 'Edit',
      icon: 'copy',
      description: 'Copy the selected objects, with their fonts and images, to the clipboard',
      permission: 'copy',
      when: selected,
      run: (ctx) => service(ctx).copy(),
    },
    {
      id: 'object.paste',
      label: 'Paste Object',
      category: 'Edit',
      icon: 'clipboard-paste',
      description: 'Paste copied objects on to the current page, in place — from any document',
      permission: 'modify',
      when: (ctx) => open(ctx) && toolIsAny(ctx),
      run: (ctx) => service(ctx).paste(),
    },
    {
      id: 'object.duplicate',
      label: 'Duplicate Object',
      category: 'Edit',
      icon: 'copy',
      shortcut: 'Mod+D',
      description: 'Make a copy of the selected objects a little to one side',
      permission: 'modify',
      when: selected,
      run: (ctx) => service(ctx).duplicate(),
    },
    {
      id: 'object.move',
      label: 'Move Object By',
      category: 'Edit',
      hidden: true,
      description: 'Internal: move the selection by { dx, dy } points',
      permission: 'modify',
      when: selected,
      run: (ctx) => service(ctx).nudge(asNumber(ctx.args['dx']), asNumber(ctx.args['dy'])),
    },
    {
      id: 'object.setBounds',
      label: 'Set Object Bounds',
      category: 'Edit',
      hidden: true,
      description: 'Internal: move or resize the selection to { x, y, width, height }',
      permission: 'modify',
      when: selected,
      run: (ctx) => {
        const patch: { x?: number; y?: number; width?: number; height?: number } = {};
        for (const k of ['x', 'y', 'width', 'height'] as const) {
          const v = ctx.args[k];
          if (typeof v === 'number') patch[k] = v;
        }
        return service(ctx).setBounds(patch);
      },
    },
    {
      id: 'object.rotate',
      label: 'Rotate Object By',
      category: 'Edit',
      hidden: true,
      description: 'Internal: rotate the selection by { degrees } anticlockwise',
      permission: 'modify',
      when: selected,
      run: (ctx) => service(ctx).rotateBy(asNumber(ctx.args['degrees'], 90)),
    },
    {
      id: 'object.rotate.ccw',
      label: 'Rotate Object Anticlockwise',
      category: 'Edit',
      icon: 'rotate-ccw',
      description: 'Turn the selected objects 90° anticlockwise about their centre',
      permission: 'modify',
      when: selected,
      run: (ctx) => service(ctx).rotateBy(90),
    },
    {
      id: 'object.rotate.cw',
      label: 'Rotate Object Clockwise',
      category: 'Edit',
      icon: 'rotate-cw',
      description: 'Turn the selected objects 90° clockwise about their centre',
      permission: 'modify',
      when: selected,
      run: (ctx) => service(ctx).rotateBy(-90),
    },
    {
      id: 'object.flip.horizontal',
      label: 'Flip Object Horizontally',
      category: 'Edit',
      icon: 'flip-horizontal-2',
      description: 'Mirror the selected objects left to right',
      permission: 'modify',
      when: selected,
      run: (ctx) => service(ctx).flip('horizontal'),
    },
    {
      id: 'object.flip.vertical',
      label: 'Flip Object Vertically',
      category: 'Edit',
      icon: 'flip-vertical-2',
      description: 'Mirror the selected objects top to bottom',
      permission: 'modify',
      when: selected,
      run: (ctx) => service(ctx).flip('vertical'),
    },

    alignCommand('left', 'Left', 'align-start-vertical'),
    alignCommand('centre', 'Centres', 'align-center-vertical'),
    alignCommand('right', 'Right', 'align-end-vertical'),
    alignCommand('top', 'Top', 'align-start-horizontal'),
    alignCommand('middle', 'Middles', 'align-center-horizontal'),
    alignCommand('bottom', 'Bottom', 'align-end-horizontal'),
    {
      id: 'object.align.toPage',
      label: 'Align To Page',
      category: 'Edit',
      description: 'Align uses the page rather than the selection as its reference',
      when: open,
      run: (ctx) => {
        const s = service(ctx);
        return s.setSetting('alignTo', s.settings.alignTo === 'page' ? 'selection' : 'page');
      },
    },
    {
      id: 'object.distribute.horizontal',
      label: 'Distribute Horizontally',
      category: 'Edit',
      icon: 'align-horizontal-distribute-center',
      description: 'Space the selected objects’ centres evenly from left to right',
      permission: 'modify',
      when: three,
      run: (ctx) => service(ctx).distribute('horizontal'),
    },
    {
      id: 'object.distribute.vertical',
      label: 'Distribute Vertically',
      category: 'Edit',
      icon: 'align-vertical-distribute-center',
      description: 'Space the selected objects’ centres evenly from top to bottom',
      permission: 'modify',
      when: three,
      run: (ctx) => service(ctx).distribute('vertical'),
    },

    arrangeCommand('front', 'Bring to Front', 'bring-to-front', 'Mod+Shift+]'),
    arrangeCommand('back', 'Send to Back', 'send-to-back', 'Mod+Shift+['),
    arrangeCommand('forward', 'Bring Forward', 'bring-to-front', 'Mod+]'),
    arrangeCommand('backward', 'Send Backward', 'send-to-back', 'Mod+['),

    {
      id: 'object.group',
      label: 'Group Objects',
      category: 'Edit',
      icon: 'group',
      shortcut: 'Mod+Shift+G',
      description: 'Make the selected objects move and select as one',
      permission: 'modify',
      when: several,
      run: (ctx) => service(ctx).group(),
    },
    {
      id: 'object.ungroup',
      label: 'Ungroup Objects',
      category: 'Edit',
      icon: 'ungroup',
      shortcut: 'Mod+Shift+U',
      description: 'Split the selected group back into its objects',
      permission: 'modify',
      when: (ctx) => selected(ctx) && service(ctx).canUngroup(),
      run: (ctx) => service(ctx).ungroup(),
    },
    {
      id: 'object.style',
      label: 'Set Object Style',
      category: 'Edit',
      hidden: true,
      description: 'Internal: set { fillColor, strokeColor, strokeWidth, dash } on selected shapes',
      permission: 'modify',
      when: selected,
      run: (ctx) => {
        const style: {
          fillColor?: number;
          strokeColor?: number;
          strokeWidth?: number;
          dash?: number[];
        } = {};
        for (const k of ['fillColor', 'strokeColor', 'strokeWidth'] as const) {
          const v = ctx.args[k];
          if (typeof v === 'number') style[k] = v;
        }
        if (Array.isArray(ctx.args['dash'])) {
          style.dash = ctx.args['dash'].filter((n): n is number => typeof n === 'number');
        }
        return service(ctx).setStyle(style);
      },
    },
    {
      id: 'object.snap.objects',
      label: 'Snap to Objects',
      category: 'Edit',
      description: 'Moving an object snaps to the edges and centres of others (smart guides)',
      when: open,
      run: (ctx) => {
        const s = service(ctx);
        return s.setSetting('snapToObjects', !s.settings.snapToObjects);
      },
    },
    {
      id: 'object.snap.guides',
      label: 'Snap to Guides',
      category: 'Edit',
      description: 'Moving an object snaps to ruler guides',
      when: open,
      run: (ctx) => {
        const s = service(ctx);
        return s.setSetting('snapToGuides', !s.settings.snapToGuides);
      },
    },

    // ---- probes for the acceptance tests -------------------------------------------------------
    {
      id: 'dev.objects',
      label: 'Objects on a page',
      category: 'Developer',
      hidden: true,
      description: 'Internal: the objects and selectable units of a page',
      when: open,
      run: async (ctx) => {
        const s = service(ctx);
        const page = asNumber(ctx.args['page']);
        const data = await s.ensurePage(page);
        if (!data) return null;
        return {
          objects: data.objects.map((o) => ({
            index: o.index,
            kind: o.kind,
            rect: o.rect,
            matrix: o.matrix,
            id: data.ids[o.index],
            fillColor: o.fillColor,
            strokeColor: o.strokeColor,
            strokeWidth: o.strokeWidth,
          })),
          units: s
            .units(data)
            .map((u) => ({ id: u.id, kind: u.kind, rect: u.rect, indexes: u.indexes })),
          groups: data.groups,
        };
      },
    },
    {
      id: 'dev.objectSelection',
      label: 'Object selection',
      category: 'Developer',
      hidden: true,
      description: 'Internal: the selected units, their bounds and the description',
      run: (ctx) => {
        if (!hasService(ctx)) return null;
        const s = service(ctx);
        const info = s.selected();
        return {
          page: s.selectionPage,
          units: s.selection,
          objectIds: info?.objectIds ?? [],
          bounds: info?.bounds ?? null,
          description: s.describe(),
          filter: s.filter,
        };
      },
    },
    {
      id: 'dev.objectState',
      label: 'Object edit state',
      category: 'Developer',
      hidden: true,
      description: 'Internal: the module’s edit state for the active document',
      run: (ctx) => {
        if (!hasService(ctx)) return null;
        const doc = service(ctx).activeDocument();
        if (!doc) return null;
        const state = readObjectsState(doc.custom(OBJECTS_NAMESPACE));
        return {
          pages: Object.fromEntries(
            Object.entries(state.pages).map(([id, p]) => [
              id,
              {
                kinds: p.kinds,
                live: p.live.map((o) =>
                  o.kind === 'base'
                    ? { ...o }
                    : { kind: o.kind, id: o.id, matrix: o.matrix, from: o.from },
                ),
                pasted: p.pasted,
                originalBytes: p.original.length,
              },
            ]),
          ),
          groups: state.groups,
        };
      },
    },
  ],

  shortcuts: [{ key: 'Delete', command: 'object.delete', scope: 'editor' }],

  ribbon: [
    {
      id: 'edit.objects',
      tab: 'edit',
      label: 'Objects',
      order: 10,
      items: [
        {
          kind: 'split',
          command: 'object.edit',
          menu: [
            'object.edit',
            'object.edit.text',
            'object.edit.image',
            'object.edit.path',
            'object.edit.shading',
          ],
          size: 'large',
        },
        'object.selectAll',
        'object.delete',
        'object.duplicate',
      ],
    },
    {
      id: 'edit.arrange',
      tab: 'edit',
      label: 'Arrange',
      order: 11,
      items: [
        {
          kind: 'dropdown',
          id: 'object.alignMenu',
          label: 'Align',
          icon: 'align-start-vertical',
          menu: [
            'object.align.left',
            'object.align.centre',
            'object.align.right',
            '-',
            'object.align.top',
            'object.align.middle',
            'object.align.bottom',
            '-',
            {
              command: 'object.align.toPage',
              checked: (ctx) => hasService(ctx) && service(ctx).settings.alignTo === 'page',
            },
          ],
        },
        {
          kind: 'dropdown',
          id: 'object.distributeMenu',
          label: 'Distribute',
          icon: 'align-horizontal-distribute-center',
          menu: ['object.distribute.horizontal', 'object.distribute.vertical'],
        },
        {
          kind: 'dropdown',
          id: 'object.arrangeMenu',
          label: 'Arrange',
          icon: 'bring-to-front',
          menu: [
            'object.arrange.front',
            'object.arrange.forward',
            'object.arrange.backward',
            'object.arrange.back',
          ],
        },
        {
          kind: 'dropdown',
          id: 'object.rotateMenu',
          label: 'Rotate',
          icon: 'rotate-cw',
          menu: [
            'object.rotate.cw',
            'object.rotate.ccw',
            '-',
            'object.flip.horizontal',
            'object.flip.vertical',
          ],
        },
        'object.group',
        'object.ungroup',
      ],
    },
  ],

  contextMenus: [
    {
      id: 'm50.objectMenu',
      region: '.viewer-scroll',
      order: 4,
      when: selected,
      items: [
        'object.cut',
        'object.copy',
        'object.paste',
        'object.duplicate',
        'object.delete',
        '-',
        'object.arrange.front',
        'object.arrange.back',
        '-',
        'object.group',
        'object.ungroup',
      ],
    },
  ],
});

function toolIsAny(ctx: ServiceContext): boolean {
  return Object.values(TOOL_ID).some((id) => toolIs(id)(ctx));
}
