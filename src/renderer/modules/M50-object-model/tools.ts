/**
 * The Edit Object tools (M50): one per filter — All, Text, Image, Shape, Shading — as Foxit's
 * Edit tab offers them. Each is a real `ToolSpec` so the shell shows it pressed and gives it the
 * cursor; the pointer work itself is `ObjectController`'s, which listens under any of them.
 */

import type { ToolSpec } from '@shared/module';
import type { ObjectService } from './ObjectService';
import { OBJECT_FILTERS, type ObjectFilter } from './settings';

export const TOOL_ID = {
  all: 'tool.editObject',
  text: 'tool.editObject.text',
  image: 'tool.editObject.image',
  path: 'tool.editObject.path',
  shading: 'tool.editObject.shading',
} as const satisfies Record<ObjectFilter, string>;

export function objectTools(service: () => ObjectService | null): ToolSpec[] {
  return OBJECT_FILTERS.map((f) => ({
    id: TOOL_ID[f.id],
    label: f.id === 'all' ? 'Edit Object' : `Edit ${f.label} Objects`,
    icon:
      f.id === 'all'
        ? 'mouse-pointer-2'
        : f.id === 'text'
          ? 'type'
          : f.id === 'image'
            ? 'image'
            : f.id === 'path'
              ? 'shapes'
              : 'blend',
    cursor: 'default',
    activateCommand: f.id === 'all' ? 'object.edit' : `object.edit.${f.id}`,
    activate: () => {
      const s = service();
      if (!s) return;
      s.setFilter(f.id);
      void s.refresh();
    },
    deactivate: () => {
      service()?.deselect();
    },
  }));
}
