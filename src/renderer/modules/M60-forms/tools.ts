/**
 * The form tools (M60): one per field type, plus Select Field and the Hand-like fill mode.
 *
 * Each is a real `ToolSpec` so the shell shows it pressed and gives it a cursor; the pointer work
 * is `FormController`'s, which listens under any of them. Activating any of them puts the widget
 * layer into design mode, which is what makes the controls inert and the boxes draggable.
 */

import type { ToolSpec } from '@shared/module';
import { FIELD_ROLES, FIELD_ROLE_LABELS, type FieldRole } from '@engine/forms/model';
import type { FormService } from './FormService';

export const SELECT_TOOL_ID = 'tool.selectField';
export const PLACE_TOOL_PREFIX = 'tool.field.';

/** The tool that places a field of `role`. */
export function placeToolId(role: FieldRole): string {
  return `${PLACE_TOOL_PREFIX}${role}`;
}

/** The role a placement tool places, or null when the id is not one. */
export function roleOfTool(toolId: string | null): FieldRole | null {
  if (!toolId?.startsWith(PLACE_TOOL_PREFIX)) return null;
  const role = toolId.slice(PLACE_TOOL_PREFIX.length);
  return FIELD_ROLES.find((r) => r === role) ?? null;
}

/** The Lucide icon each field type is drawn with. Generic conventions, never Foxit's artwork. */
export const ROLE_ICON: Readonly<Record<FieldRole, string>> = {
  text: 'text-cursor-input',
  checkbox: 'square-check',
  radio: 'circle-dot',
  combobox: 'square-chevron-down',
  listbox: 'list',
  button: 'rectangle-horizontal',
  signature: 'pen-line',
  image: 'image',
  date: 'calendar',
  barcode: 'qr-code',
};

export function formTools(service: () => FormService | null): ToolSpec[] {
  const design = (): void => {
    service()?.setMode('design');
  };
  const tools: ToolSpec[] = [
    {
      id: SELECT_TOOL_ID,
      label: 'Select Field',
      icon: 'mouse-pointer-2',
      cursor: 'default',
      activateCommand: 'form.select',
      activate: design,
      deactivate: () => {
        service()?.deselect();
      },
    },
  ];
  for (const role of FIELD_ROLES) {
    tools.push({
      id: placeToolId(role),
      label: FIELD_ROLE_LABELS[role],
      icon: ROLE_ICON[role],
      cursor: 'crosshair',
      activateCommand: `form.place.${role}`,
      activate: design,
    });
  }
  return tools;
}
