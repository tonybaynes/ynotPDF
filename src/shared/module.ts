/**
 * Module manifest contracts (M00). Every feature module folder
 * `src/renderer/modules/<Mid>-<slug>/` exports a `manifest.ts` whose default export is a
 * {@link ModuleManifest}. The application shell (M02) is data-driven from these manifests:
 * it knows nothing about individual features.
 *
 * Rules that every module must follow (see CLAUDE.md):
 * - Every user action is a registered {@link CommandSpec} so it appears in the command palette.
 * - Every document change performed by a command is an undoable `Command`
 *   (see `src/renderer/core/Command.ts`).
 * - Shortcuts use `Mod` for Ctrl (Windows/Linux) / Cmd (macOS).
 */

/** Module identifier, e.g. `"M30"`. */
export type ModuleId = `M${number}`;

/**
 * Ribbon tab identifiers (PLAN.md §3.3). Modules add *groups* to these tabs; the shell owns
 * the tabs themselves.
 */
export type RibbonTabId =
  | 'file'
  | 'home'
  | 'edit'
  | 'comment'
  | 'view'
  | 'form'
  | 'protect'
  | 'organize'
  | 'convert'
  | 'accessibility'
  | 'help';

/** Command palette category shown next to the label. */
export type CommandCategory =
  | 'Application'
  | 'File'
  | 'Edit'
  | 'View'
  | 'Comment'
  | 'Form'
  | 'Protect'
  | 'Organize'
  | 'Convert'
  | 'Accessibility'
  | 'Help'
  | 'Developer';

/** Arguments a command accepts. Must be structured-cloneable (they cross the e2e bridge). */
export type CommandArgs = Readonly<Record<string, unknown>>;

/**
 * What a command receives when it runs. The concrete context is built by the Registry
 * (`src/renderer/core/Registry.ts`); the shape here is deliberately narrow so module code can
 * be unit-tested with a plain object.
 */
export interface CommandContext {
  /** Arguments passed by the caller (palette, shortcut, menu, e2e harness). */
  readonly args: CommandArgs;
  /** Run another command by id. */
  run(commandId: string, args?: CommandArgs): Promise<unknown>;
  /** Services registered by the shell/modules (document, selection, undo, dialogs, ...). */
  service<T>(name: string): T;
}

/** The context without per-call arguments (used by `when` clauses, panels, tools, activate). */
export type ServiceContext = Omit<CommandContext, 'args'>;

/** Predicate deciding whether a command is currently enabled/visible. */
export type WhenClause = (ctx: ServiceContext) => boolean;

/** A user-invokable command. Lives in the palette; may be bound to ribbon, menu, shortcut. */
export interface CommandSpec {
  /** Stable id, dotted and lowercase: `"file.open"`, `"annot.highlight"`. Unique app-wide. */
  readonly id: string;
  /** Human label shown in the palette / ribbon / menu. */
  readonly label: string;
  readonly category: CommandCategory;
  /** Optional longer description for the palette's secondary line. */
  readonly description?: string;
  /** Lucide icon name (kebab-case), drawn with `currentColor`. */
  readonly icon?: string;
  /** Default shortcut, e.g. `"Mod+O"`, `"Mod+Shift+P"`, `"F11"`. See {@link ShortcutSpec}. */
  readonly shortcut?: string;
  /** Enabled/visible predicate. Absent means always enabled. */
  readonly when?: WhenClause;
  /** If true the palette hides it (still runnable by id, e.g. internal or e2e-only commands). */
  readonly hidden?: boolean;
  /** Runs the command. May be async. Return value is passed back to the caller (e2e harness). */
  run(ctx: CommandContext): unknown;
}

/** A group of controls on a ribbon tab. */
export interface RibbonGroupSpec {
  /** Unique id, e.g. `"comment.markup"`. */
  readonly id: string;
  readonly tab: RibbonTabId;
  readonly label: string;
  /** Lower first. Groups from different modules interleave by order, then by id. */
  readonly order?: number;
  /** Command ids shown as buttons, in order. The literal `"-"` inserts a separator. */
  readonly items: ReadonlyArray<string>;
  /** Command ids shown as "large" buttons (the rest render small). */
  readonly large?: ReadonlyArray<string>;
}

/** Where a panel docks. */
export type PanelDock = 'left' | 'right' | 'bottom';

/** A dockable panel (navigation pane tab, properties pane, results pane, ...). */
export interface PanelSpec {
  /** Unique id, e.g. `"nav.thumbnails"`. */
  readonly id: string;
  readonly title: string;
  readonly dock: PanelDock;
  readonly icon?: string;
  readonly order?: number;
  /** Command that toggles this panel; auto-generated as `panel.<id>` if absent. */
  readonly toggleCommand?: string;
  /**
   * Mounts the panel's DOM into `host`. Returns a disposer. Called lazily the first time the
   * panel becomes visible; the panel keeps its own state via the Store.
   */
  mount(host: HTMLElement, ctx: ServiceContext): () => void;
}

/**
 * Pointer/keyboard handler bound to the page overlay ("tool layer"). One tool is active at a
 * time; the shell activates it via the tool's `activateCommand`.
 *
 * Coordinates handed to a tool are in **PDF user space** of the page under the pointer
 * (points, origin bottom-left); the view converts device pixels for you.
 */
export interface ToolSpec {
  /** Unique id, e.g. `"tool.hand"`, `"tool.highlight"`. */
  readonly id: string;
  readonly label: string;
  readonly icon?: string;
  /** Cursor CSS value while active. */
  readonly cursor?: string;
  /** Command id that activates the tool (auto-generated as `<id>.activate` if absent). */
  readonly activateCommand?: string;
  /** Called when the tool becomes active / inactive. */
  activate?(ctx: ServiceContext): void;
  deactivate?(): void;
  /** Pointer events, already translated to page space. Return `true` if consumed. */
  onPointerDown?(e: ToolPointerEvent): boolean | undefined;
  onPointerMove?(e: ToolPointerEvent): boolean | undefined;
  onPointerUp?(e: ToolPointerEvent): boolean | undefined;
  onKeyDown?(e: KeyboardEvent): boolean | undefined;
}

/** Pointer event translated into page coordinates. */
export interface ToolPointerEvent {
  readonly page: number;
  /** Position in PDF user space (points, origin bottom-left). */
  readonly x: number;
  readonly y: number;
  /** Position in device pixels relative to the page element (origin top-left). */
  readonly clientX: number;
  readonly clientY: number;
  readonly buttons: number;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly original: PointerEvent;
}

/**
 * Keyboard shortcut. Syntax: modifiers joined by `+` then a key name as produced by
 * `KeyboardEvent.key` (letters uppercase): `"Mod+O"`, `"Mod+Shift+P"`, `"Alt+ArrowLeft"`,
 * `"F11"`, `"Escape"`. `Mod` = Ctrl on Windows/Linux, Cmd on macOS.
 */
export interface ShortcutSpec {
  readonly key: string;
  readonly command: string;
  readonly args?: CommandArgs;
  /** Restrict to a context: `"editor"` (default, page area), `"global"` (even in inputs). */
  readonly scope?: 'editor' | 'global';
}

/** A JSON-schema-like description of a module's settings (validated by M130's preferences UI). */
export interface SettingsSchema {
  /** Settings key prefix, usually the module id or feature name. */
  readonly namespace: string;
  readonly properties: Readonly<Record<string, SettingSpec>>;
}

/** One setting. `default` must match `type`. */
export type SettingSpec =
  | { readonly type: 'boolean'; readonly title: string; readonly default: boolean }
  | {
      readonly type: 'number';
      readonly title: string;
      readonly default: number;
      readonly min?: number;
      readonly max?: number;
      readonly step?: number;
    }
  | { readonly type: 'string'; readonly title: string; readonly default: string }
  | {
      readonly type: 'enum';
      readonly title: string;
      readonly default: string;
      readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
    };

/** The manifest every module exports from `manifest.ts`. All arrays default to empty. */
export interface ModuleManifest {
  readonly id: ModuleId;
  /** Short human name, e.g. `"Viewer"`. */
  readonly name: string;
  readonly commands?: ReadonlyArray<CommandSpec>;
  readonly ribbon?: ReadonlyArray<RibbonGroupSpec>;
  readonly panels?: ReadonlyArray<PanelSpec>;
  readonly tools?: ReadonlyArray<ToolSpec>;
  /** Extra bindings beyond `CommandSpec.shortcut` (e.g. secondary keys, tool activation). */
  readonly shortcuts?: ReadonlyArray<ShortcutSpec>;
  readonly settings?: SettingsSchema;
  /**
   * Called once after all manifests are registered and the shell is mounted. Use it to register
   * services or subscribe to the store. Returns an optional disposer.
   */
  activate?(ctx: ServiceContext): undefined | (() => void);
}

/** Helper for type-safe manifest declarations. */
export function defineModule(manifest: ModuleManifest): ModuleManifest {
  return manifest;
}
