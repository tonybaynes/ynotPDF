/**
 * The bundle of services every shell region receives (M02). Kept as one object so regions can
 * be mounted independently (and tested with fakes) without import cycles through the shell.
 * The same objects are registered by name on the Registry so module commands reach them via
 * `ctx.service('dialogs')` etc.
 */

import type { Registry } from '@core/Registry';
import type { Selection } from '@core/Selection';
import type { ContextMenus } from './contextMenu';
import type { Dialogs } from './dialog/Dialogs';
import type { Toasts } from './dialog/toast';
import type { Documents } from './tabs/Documents';
import type { UiStore } from './ui/UiState';

export interface ShellServices {
  readonly registry: Registry;
  readonly ui: UiStore;
  readonly documents: Documents;
  readonly dialogs: Dialogs;
  readonly toasts: Toasts;
  readonly contextMenus: ContextMenus;
  readonly selection: Selection;
  readonly isMac: boolean;
  /** Re-evaluate every `when()` (bumps `ui.revision`). */
  invalidate(): void;
  /** Runs a command, closing popups first and reporting failures as an error toast. */
  run(commandId: string, args?: Readonly<Record<string, unknown>>): Promise<unknown>;
}

/** Service names modules use with `ctx.service(name)`. */
export const SERVICE = {
  ui: 'ui',
  documents: 'documents',
  tabs: 'tabs',
  dialogs: 'dialogs',
  toasts: 'toasts',
  contextMenu: 'contextMenu',
  panels: 'panels',
  tools: 'tools',
  ribbon: 'ribbon',
  statusBar: 'statusBar',
  backstage: 'backstage',
  focus: 'focus',
  shortcuts: 'shortcuts',
  windowState: 'windowState',
  /** M130's settings hub: read, write, reset, import/export and live apply (ADR 0018). */
  settings: 'settings',
} as const;
