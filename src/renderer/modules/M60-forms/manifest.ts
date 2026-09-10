/**
 * M60 manifest — the Form tab: fill mode and the designer, one placement tool per field type,
 * the Fields panel, the field properties panel, tab order, highlight, alignment and Reset Form.
 *
 * Every user action is a registered command, so it is in the palette, on a shortcut where one
 * makes sense, and drivable by id from the e2e suite; the ones that take arguments (`form.place`
 * with `{ role, page, rect }`, `form.setValue` with `{ name, value }`) exist so a test — or a
 * batch — can do without a pointer. The probes at the bottom are how the acceptance tests read
 * this module out of the running app.
 */

import {
  Calendar,
  CircleDot,
  ClipboardPaste,
  Copy,
  Eye,
  Image as ImageIcon,
  List,
  ListOrdered,
  MousePointer2,
  PenLine,
  QrCode,
  RectangleHorizontal,
  RotateCcw,
  Scissors,
  SquareCheck,
  SquareChevronDown,
  SquareStack,
  TableProperties,
  TextCursorInput,
  Trash2,
} from 'lucide';
import { registerIcon } from '@app/icons';
import type { ShellServices } from '@app/services';
import { SERVICE } from '@app/services';
import type { Dialogs } from '@app/dialog/Dialogs';
import type { Registry } from '@core/Registry';
import { fieldDesignOf } from '@core/model';
import {
  FIELD_ROLES,
  FIELD_ROLE_LABELS,
  TAB_ORDER_MODES,
  type FieldRole,
  type TabOrderMode,
} from '@engine/forms/model';
import { defineModule, type CommandSpec, type ServiceContext } from '@shared/module';
import type { AlignEdge } from '@modules/M50-object-model/geometry';
import { FormController } from './FormController';
import {
  FIELD_PANEL_ID,
  FIELD_PROPERTIES_PANEL_ID,
  FORM_SERVICE,
  FormService,
} from './FormService';
import { mountFieldsPanel } from './FieldsPanel';
import { mountFieldPropertiesPanel } from './PropertiesPanel';
import { FORM_SETTINGS_SCHEMA } from './settings';
import { openTabOrderDialog } from './TabOrderDialog';
import { ROLE_ICON, SELECT_TOOL_ID, formTools, placeToolId } from './tools';
import './forms.css';

export {
  FORM_SERVICE,
  FIELD_PANEL_ID,
  FIELD_PROPERTIES_PANEL_ID,
  FormService,
} from './FormService';

registerIcon('text-cursor-input', TextCursorInput);
registerIcon('square-check', SquareCheck);
registerIcon('circle-dot', CircleDot);
registerIcon('square-chevron-down', SquareChevronDown);
registerIcon('list', List);
registerIcon('rectangle-horizontal', RectangleHorizontal);
registerIcon('pen-line', PenLine);
registerIcon('image', ImageIcon);
registerIcon('calendar', Calendar);
registerIcon('qr-code', QrCode);
registerIcon('mouse-pointer-2', MousePointer2);
registerIcon('list-ordered', ListOrdered);
registerIcon('table-properties', TableProperties);
registerIcon('square-stack', SquareStack);
registerIcon('rotate-ccw', RotateCcw);
registerIcon('eye', Eye);
registerIcon('trash-2', Trash2);
registerIcon('copy', Copy);
registerIcon('clipboard-paste', ClipboardPaste);
registerIcon('scissors', Scissors);

let live: FormService | null = null;
const lookup = (): FormService | null => live;

const service = (ctx: ServiceContext): FormService => ctx.service<FormService>(FORM_SERVICE);

const hasService = (ctx: ServiceContext): boolean =>
  ctx.service<Registry>('registry').hasService(FORM_SERVICE);

const open = (ctx: ServiceContext): boolean =>
  hasService(ctx) && service(ctx).activeDocument() !== null;

const hasFields = (ctx: ServiceContext): boolean =>
  open(ctx) &&
  (service(ctx)
    .activeDocument()
    ?.state.fields.some((f) => !f.synthetic) ??
    false);

const selected = (ctx: ServiceContext): boolean =>
  hasService(ctx) && service(ctx).selection.length > 0;

const several = (ctx: ServiceContext): boolean =>
  hasService(ctx) && service(ctx).selection.length > 1;

const three = (ctx: ServiceContext): boolean =>
  hasService(ctx) && service(ctx).selection.length > 2;

const designing = (ctx: ServiceContext): boolean =>
  hasService(ctx) && service(ctx).mode === 'design';

function activateTool(ctx: ServiceContext, id: string): void {
  ctx.service<{ activate(id: string): void }>(SERVICE.tools).activate(id);
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The page the reader is looking at, which is what a page-scoped command acts on. */
function currentPage(ctx: ServiceContext): number {
  const s = service(ctx);
  const explicit = s.selectionInfo().page;
  if (explicit !== null && explicit >= 0) return explicit;
  const viewer = s.activeViewer();
  return viewer ? viewer.state.page : 0;
}

function placeCommand(role: FieldRole): CommandSpec {
  return {
    id: `form.place.${role}`,
    label: FIELD_ROLE_LABELS[role],
    category: 'Form',
    icon: ROLE_ICON[role],
    description: `Draw a ${FIELD_ROLE_LABELS[role].toLowerCase()} on the page`,
    permission: 'modify',
    when: open,
    run: (ctx) => {
      activateTool(ctx, placeToolId(role));
    },
  };
}

function alignCommand(edge: AlignEdge, label: string, icon: string): CommandSpec {
  return {
    id: `form.align.${edge}`,
    label: `Align ${label}`,
    category: 'Form',
    icon,
    description: 'Line the selected fields up on this edge',
    permission: 'modify',
    when: several,
    run: (ctx) => service(ctx).align(edge),
  };
}

function tabOrderCommand(mode: TabOrderMode, label: string): CommandSpec {
  return {
    id: `form.tabOrder.${mode}`,
    label,
    category: 'Form',
    description: 'Set how the reader tabs from one field to the next on this page',
    permission: 'modify',
    when: hasFields,
    run: async (ctx) => {
      const page = asNumber(ctx.args['page'], currentPage(ctx));
      await service(ctx).autoOrder(page, mode);
    },
  };
}

export default defineModule({
  id: 'M60',
  name: 'Forms',

  activate(ctx) {
    const registry = ctx.service<Registry>('registry');
    if (registry.hasService(FORM_SERVICE)) return undefined;
    const shell = ctx.service<ShellServices>('shellServices');
    const created = new FormService({ registry, shell });
    live = created;
    registry.provide(FORM_SERVICE, created);
    const host = document.querySelector<HTMLElement>('.viewer-host') ?? document.body;
    const controller = new FormController({ service: created, shell, host });
    return () => {
      controller.dispose();
      created.dispose();
      live = null;
    };
  },

  tools: formTools(lookup),

  settings: FORM_SETTINGS_SCHEMA,

  panels: [
    {
      id: FIELD_PANEL_ID,
      title: 'Fields',
      dock: 'left',
      icon: 'text-cursor-input',
      order: 60,
      mount: (element, context) => mountFieldsPanel(element, service(context)),
    },
    {
      id: FIELD_PROPERTIES_PANEL_ID,
      title: 'Field',
      dock: 'right',
      icon: 'table-properties',
      // Order 0 like M30's and M50's: a panel bound to the selection outranks a document-wide one.
      order: 0,
      when: selected,
      mount: (element, context) => mountFieldPropertiesPanel(element, service(context)),
    },
  ],

  commands: [
    {
      id: 'form.fill',
      label: 'Fill In Form',
      category: 'Form',
      icon: 'text-cursor-input',
      description: 'Type into the form fields on the page',
      when: open,
      run: (ctx) => {
        service(ctx).setMode('fill');
        activateTool(ctx, 'tool.hand');
      },
    },
    {
      id: 'form.select',
      label: 'Select Field',
      category: 'Form',
      icon: 'mouse-pointer-2',
      description: 'Select, move and resize form fields',
      permission: 'modify',
      when: open,
      run: (ctx) => {
        activateTool(ctx, SELECT_TOOL_ID);
      },
    },
    ...FIELD_ROLES.map(placeCommand),
    {
      id: 'form.place',
      label: 'Add Field',
      category: 'Form',
      hidden: true,
      description: 'Internal: create a field of a type at a rectangle on a page',
      permission: 'modify',
      when: open,
      run: async (ctx) => {
        const role = FIELD_ROLES.find((r) => r === ctx.args['role']) ?? 'text';
        const rect = ctx.args['rect'] as Record<string, unknown> | undefined;
        const field = await service(ctx).createField(role, asNumber(ctx.args['page']), {
          x0: asNumber(rect?.['x0']),
          y0: asNumber(rect?.['y0']),
          x1: asNumber(rect?.['x1']),
          y1: asNumber(rect?.['y1']),
        });
        return field ? { id: field.id, name: field.name } : null;
      },
    },
    {
      id: 'form.selectField',
      label: 'Select Fields',
      category: 'Form',
      hidden: true,
      description: 'Internal: select fields by name',
      when: open,
      run: (ctx) => {
        const s = service(ctx);
        const document_ = s.activeDocument();
        if (!document_) return [];
        const names = Array.isArray(ctx.args['names'])
          ? ctx.args['names'].filter((n): n is string => typeof n === 'string')
          : [];
        const keys: string[] = [];
        for (const name of names) {
          const field = document_.fieldByName(name);
          if (!field) continue;
          for (const widget of field.widgets) keys.push(`${field.id}:${widget.id}`);
        }
        s.select(keys, asNumber(ctx.args['page'], currentPage(ctx)));
        return s.selection;
      },
    },
    {
      id: 'form.selectAll',
      label: 'Select All Fields',
      category: 'Form',
      description: 'Select every field on the current page',
      when: hasFields,
      run: (ctx) => {
        service(ctx).selectAllOnPage(asNumber(ctx.args['page'], currentPage(ctx)));
      },
    },
    {
      id: 'form.deselect',
      label: 'Deselect Fields',
      category: 'Form',
      description: 'Clear the field selection',
      when: selected,
      run: (ctx) => {
        service(ctx).deselect();
      },
    },
    {
      id: 'form.setValue',
      label: 'Set Field Value',
      category: 'Form',
      hidden: true,
      description: 'Internal: set a field value by name',
      permission: 'fill-forms',
      when: hasFields,
      run: async (ctx) => {
        const s = service(ctx);
        const document_ = s.activeDocument();
        const name = asText(ctx.args['name']);
        const field = document_?.fieldByName(name);
        const widget = field?.widgets[0];
        if (!field || !widget) return null;
        await s.commitValue(`${field.id}:${widget.id}`, asText(ctx.args['value']));
        return s.activeDocument()?.fieldByName(name)?.value ?? null;
      },
    },
    {
      id: 'form.nextField',
      label: 'Next Field',
      category: 'Form',
      description: 'Move the keyboard to the next field in tab order',
      when: hasFields,
      run: (ctx) => service(ctx).focusNext(false),
    },
    {
      id: 'form.previousField',
      label: 'Previous Field',
      category: 'Form',
      description: 'Move the keyboard to the previous field in tab order',
      when: hasFields,
      run: (ctx) => service(ctx).focusNext(true),
    },
    {
      id: 'form.highlight',
      label: 'Highlight Fields',
      category: 'Form',
      icon: 'eye',
      description: 'Draw a tinted box behind every field so an empty form shows where to type',
      when: hasFields,
      run: (ctx) => {
        service(ctx).toggleHighlight();
      },
    },
    {
      id: 'form.showTabOrder',
      label: 'Show Tab Order',
      category: 'Form',
      icon: 'list-ordered',
      description: 'Number every field on the page in the order the keyboard visits it',
      when: hasFields,
      run: (ctx) => {
        service(ctx).toggleTabOrder();
      },
    },
    {
      id: 'form.setTabOrder',
      label: 'Set Tab Order…',
      category: 'Form',
      icon: 'list-ordered',
      description: 'Choose the rule, or set the order of this page’s fields by hand',
      permission: 'modify',
      when: hasFields,
      run: async (ctx) => {
        await openTabOrderDialog(
          ctx.service<Dialogs>(SERVICE.dialogs),
          service(ctx),
          asNumber(ctx.args['page'], currentPage(ctx)),
        );
      },
    },
    ...TAB_ORDER_MODES.filter((m) => m !== 'manual').map((m) =>
      tabOrderCommand(
        m,
        m === 'row'
          ? 'Tab Order By Row'
          : m === 'column'
            ? 'Tab Order By Column'
            : 'Tab Order By Structure',
      ),
    ),
    {
      id: 'form.resetForm',
      label: 'Reset Form',
      category: 'Form',
      icon: 'rotate-ccw',
      description: 'Put every field back to the value it starts with',
      permission: 'fill-forms',
      when: hasFields,
      run: (ctx) => service(ctx).resetForm(),
    },
    {
      id: 'form.delete',
      label: 'Delete Field',
      category: 'Form',
      icon: 'trash-2',
      description: 'Remove the selected fields from the document',
      permission: 'modify',
      when: selected,
      run: (ctx) => service(ctx).deleteSelection(),
    },
    {
      id: 'form.copy',
      label: 'Copy Field',
      category: 'Form',
      icon: 'copy',
      description: 'Copy the selected fields to the clipboard',
      permission: 'copy',
      when: selected,
      run: (ctx) => service(ctx).copy(),
    },
    {
      id: 'form.cut',
      label: 'Cut Field',
      category: 'Form',
      icon: 'scissors',
      description: 'Copy the selected fields to the clipboard and remove them',
      permission: 'modify',
      when: selected,
      run: (ctx) => service(ctx).cut(),
    },
    {
      id: 'form.paste',
      label: 'Paste Field',
      category: 'Form',
      icon: 'clipboard-paste',
      description: 'Paste copied fields on to the current page, with fresh names',
      permission: 'modify',
      when: open,
      run: (ctx) => service(ctx).paste(asNumber(ctx.args['page'], currentPage(ctx))),
    },
    {
      id: 'form.duplicate',
      label: 'Duplicate Across Pages…',
      category: 'Form',
      icon: 'square-stack',
      description: 'Copy the selected fields on to other pages, each with its own name',
      permission: 'modify',
      when: selected,
      run: async (ctx) => {
        const s = service(ctx);
        const document_ = s.activeDocument();
        if (!document_) return 0;
        const explicit = ctx.args['pages'];
        if (Array.isArray(explicit)) {
          return await s.duplicateToPages(
            explicit.filter((n): n is number => typeof n === 'number'),
          );
        }
        const here = currentPage(ctx);
        const dialogs = ctx.service<Dialogs>(SERVICE.dialogs);
        const answer = await dialogs.prompt({
          title: 'Duplicate fields across pages',
          label: 'Pages',
          hint: `1 to ${String(document_.state.pages.length)}, as "2-5" or "2,4,7". Page ${String(here + 1)} is left alone.`,
          value: `1-${String(document_.state.pages.length)}`,
          okLabel: 'Duplicate',
        });
        if (answer === null) return 0;
        const pages = parsePages(answer, document_.state.pages.length).filter((p) => p !== here);
        const n = await s.duplicateToPages(pages);
        return n;
      },
    },
    {
      id: 'form.move',
      label: 'Move Field',
      category: 'Form',
      hidden: true,
      description: 'Internal: move the selected fields by an offset in points',
      permission: 'modify',
      when: selected,
      run: (ctx) => service(ctx).moveSelection(asNumber(ctx.args['dx']), asNumber(ctx.args['dy'])),
    },
    alignCommand('left', 'Left', 'align-start-vertical'),
    alignCommand('centre', 'Centre', 'align-center-vertical'),
    alignCommand('right', 'Right', 'align-end-vertical'),
    alignCommand('top', 'Top', 'align-start-horizontal'),
    alignCommand('middle', 'Middle', 'align-center-horizontal'),
    alignCommand('bottom', 'Bottom', 'align-end-horizontal'),
    {
      id: 'form.distribute.horizontal',
      label: 'Space Across',
      category: 'Form',
      icon: 'align-horizontal-distribute-center',
      description: 'Space the selected fields evenly from left to right',
      permission: 'modify',
      when: three,
      run: (ctx) => service(ctx).distribute('horizontal'),
    },
    {
      id: 'form.distribute.vertical',
      label: 'Space Down',
      category: 'Form',
      icon: 'align-vertical-distribute-center',
      description: 'Space the selected fields evenly from top to bottom',
      permission: 'modify',
      when: three,
      run: (ctx) => service(ctx).distribute('vertical'),
    },
    {
      id: 'form.matchSize.width',
      label: 'Same Width',
      category: 'Form',
      description: 'Make every selected field as wide as the first one selected',
      permission: 'modify',
      when: several,
      run: (ctx) => service(ctx).matchSize('width'),
    },
    {
      id: 'form.matchSize.height',
      label: 'Same Height',
      category: 'Form',
      description: 'Make every selected field as tall as the first one selected',
      permission: 'modify',
      when: several,
      run: (ctx) => service(ctx).matchSize('height'),
    },
    {
      id: 'form.matchSize.both',
      label: 'Same Size',
      category: 'Form',
      description: 'Make every selected field the size of the first one selected',
      permission: 'modify',
      when: several,
      run: (ctx) => service(ctx).matchSize('both'),
    },
    {
      id: 'form.snapToGrid',
      label: 'Snap Fields To Grid',
      category: 'Form',
      description: 'Round a drawn or dragged field to the grid',
      when: open,
      run: (ctx) => {
        const s = service(ctx);
        return s.setSetting('snapToGrid', !s.settings.snapToGrid);
      },
    },

    // ---- probes: how the acceptance tests read this module out of the running app ------------
    {
      id: 'dev.formFields',
      label: 'Probe: Form Fields',
      category: 'Developer',
      hidden: true,
      description: 'Internal: the document’s fields as data, for tests',
      when: open,
      run: (ctx) => {
        const document_ = service(ctx).activeDocument();
        if (!document_) return [];
        return document_.state.fields
          .filter((f) => !f.synthetic)
          .map((f) => {
            const design = fieldDesignOf(f);
            return {
              id: f.id,
              name: f.name,
              role: design.role,
              value: f.value,
              flags: design.flags,
              options: design.options,
              widgets: f.widgets.map((w) => ({
                id: w.id,
                page: document_.pageIndex(w.pageId),
                rect: w.rect,
              })),
            };
          });
      },
    },
    {
      id: 'dev.formSelection',
      label: 'Probe: Field Selection',
      category: 'Developer',
      hidden: true,
      description: 'Internal: the selected fields, for tests',
      when: open,
      run: (ctx) => {
        const info = service(ctx).selectionInfo();
        return {
          keys: service(ctx).selection,
          names: info.fields.map((f) => f.name),
          bounds: info.bounds,
          page: info.page,
        };
      },
    },
    {
      id: 'dev.formTabOrder',
      label: 'Probe: Tab Order',
      category: 'Developer',
      hidden: true,
      description: 'Internal: the tab order of a page, for tests',
      when: open,
      run: (ctx) => {
        const s = service(ctx);
        const page = asNumber(ctx.args['page'], currentPage(ctx));
        return {
          mode: s.tabModeOf(page),
          names: s.tabOrderOf(page).map((w) => w.field.name),
        };
      },
    },
  ],

  /*
   * No shortcuts of its own. Every key this module would have wanted is already spoken for:
   * Ctrl+A selects text (M13), Escape closes what is open (M02), Ctrl+Shift+F is Advanced Search
   * (M13). Taking one of them would break a key the reader already knows for the sake of a key
   * they do not. Escape and the arrow keys still work over a selected field — `FormController`
   * handles them while a form tool is active, which is scoped to the tool rather than to the app.
   */

  ribbon: [
    {
      id: 'form.mode',
      tab: 'form',
      label: 'Form',
      order: 0,
      items: [
        { kind: 'button', command: 'form.fill', size: 'large' },
        {
          kind: 'toggle',
          command: 'form.select',
          pressed: (ctx) => designing(ctx),
          size: 'large',
        },
        {
          kind: 'toggle',
          command: 'form.highlight',
          pressed: (ctx) => hasService(ctx) && service(ctx).highlight,
        },
        'form.resetForm',
      ],
    },
    {
      id: 'form.fields',
      tab: 'form',
      label: 'Fields',
      order: 10,
      items: [
        { kind: 'button', command: 'form.place.text', size: 'large' },
        'form.place.checkbox',
        'form.place.radio',
        'form.place.combobox',
        'form.place.listbox',
        'form.place.button',
        'form.place.signature',
        'form.place.image',
        'form.place.date',
        'form.place.barcode',
      ],
    },
    {
      id: 'form.arrange',
      tab: 'form',
      label: 'Arrange',
      order: 20,
      items: [
        {
          kind: 'dropdown',
          id: 'form.alignMenu',
          label: 'Align',
          icon: 'align-start-vertical',
          menu: [
            'form.align.left',
            'form.align.centre',
            'form.align.right',
            '-',
            'form.align.top',
            'form.align.middle',
            'form.align.bottom',
          ],
        },
        {
          kind: 'dropdown',
          id: 'form.distributeMenu',
          label: 'Distribute',
          icon: 'align-horizontal-distribute-center',
          menu: ['form.distribute.horizontal', 'form.distribute.vertical'],
        },
        {
          kind: 'dropdown',
          id: 'form.sizeMenu',
          label: 'Size',
          icon: 'square-stack',
          menu: ['form.matchSize.width', 'form.matchSize.height', 'form.matchSize.both'],
        },
        {
          kind: 'toggle',
          command: 'form.snapToGrid',
          pressed: (ctx) => hasService(ctx) && service(ctx).settings.snapToGrid,
        },
        'form.duplicate',
        'form.delete',
      ],
    },
    {
      id: 'form.order',
      tab: 'form',
      label: 'Tab order',
      order: 30,
      items: [
        {
          kind: 'toggle',
          command: 'form.showTabOrder',
          pressed: (ctx) => hasService(ctx) && service(ctx).tabOrderShown,
        },
        {
          kind: 'split',
          command: 'form.setTabOrder',
          menu: ['form.tabOrder.row', 'form.tabOrder.column', 'form.tabOrder.structure'],
        },
      ],
    },
  ],

  contextMenus: [
    {
      id: 'm60.fieldMenu',
      region: '.viewer-scroll',
      order: 5,
      when: selected,
      items: [
        'form.cut',
        'form.copy',
        'form.paste',
        'form.duplicate',
        'form.delete',
        '-',
        'form.align.left',
        'form.align.top',
        '-',
        'form.setTabOrder',
      ],
    },
  ],
});

/** `"2-5"`, `"2,4,7"`, `"all"` → zero-based page indexes inside the document. */
export function parsePages(text: string, count: number): number[] {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === '' || trimmed === 'all') return Array.from({ length: count }, (_v, i) => i);
  const out = new Set<number>();
  for (const part of trimmed.split(',')) {
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part.trim());
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      for (let n = Math.min(from, to); n <= Math.max(from, to); n++) {
        if (n >= 1 && n <= count) out.add(n - 1);
      }
      continue;
    }
    const one = Number(part.trim());
    if (Number.isFinite(one) && one >= 1 && one <= count) out.add(one - 1);
  }
  return [...out].sort((a, b) => a - b);
}
