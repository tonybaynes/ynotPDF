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
  /**
   * Ribbon key tip (the letters shown after Alt), e.g. `"FO"`. Generated from the label when
   * absent (M02, ADR 0004).
   */
  readonly keyTip?: string;
  /** Runs the command. May be async. Return value is passed back to the caller (e2e harness). */
  run(ctx: CommandContext): unknown;
}

/**
 * A menu entry inside a dropdown, split button or context menu (M02, ADR 0004). A plain string
 * is a command id (`"-"` is a separator); the object form adds a label override, arguments, a
 * submenu or a check state.
 */
export type MenuItemSpec =
  | string
  | {
      readonly label?: string;
      readonly command?: string;
      readonly args?: CommandArgs;
      readonly icon?: string;
      readonly submenu?: ReadonlyArray<MenuItemSpec>;
      /** Shown as a checked item (tick icon + "on" for screen readers) when true. */
      readonly checked?: (ctx: ServiceContext) => boolean;
      readonly when?: WhenClause;
    };

/** Large or small ribbon button. */
export type RibbonItemSize = 'large' | 'small';

/** A menu: a static list, or a function evaluated each time the menu opens (recent files). */
export type RibbonMenu = ReadonlyArray<MenuItemSpec> | (() => ReadonlyArray<MenuItemSpec>);

/** One choice in a gallery, colour picker or select input. */
export interface RibbonOptionSpec {
  readonly value: string;
  readonly label: string;
  readonly icon?: string;
}

/**
 * One control in a ribbon group (M02, ADR 0004). A plain string is a command id rendered as a
 * button (`"-"` inserts a separator); the object forms describe richer controls. The shell owns
 * the DOM, keyboard behaviour and theme of every kind.
 */
export type RibbonItemSpec =
  | string
  | {
      readonly kind: 'button';
      readonly command: string;
      readonly size?: RibbonItemSize;
      /** Overrides for shell-generated buttons (the File tab); commands normally supply these. */
      readonly label?: string;
      readonly icon?: string;
      readonly title?: string;
    }
  | {
      /** Main action plus an arrow that opens `menu`. */
      readonly kind: 'split';
      readonly command: string;
      readonly menu: RibbonMenu;
      readonly size?: RibbonItemSize;
    }
  | {
      /** Button that opens `menu`. */
      readonly kind: 'dropdown';
      readonly id: string;
      readonly label: string;
      readonly icon?: string;
      readonly menu: RibbonMenu;
      readonly size?: RibbonItemSize;
      readonly when?: WhenClause;
    }
  | {
      /** Button with `aria-pressed` driven by `pressed(ctx)`; clicking runs `command`. */
      readonly kind: 'toggle';
      readonly command: string;
      readonly pressed: (ctx: ServiceContext) => boolean;
      readonly size?: RibbonItemSize;
    }
  | {
      /** Grid popup of options; choosing one runs `command` with `{ value }`. */
      readonly kind: 'gallery';
      readonly id: string;
      readonly label: string;
      readonly icon?: string;
      readonly command: string;
      readonly options: ReadonlyArray<RibbonOptionSpec>;
      readonly selected?: (ctx: ServiceContext) => string;
      readonly size?: RibbonItemSize;
      readonly when?: WhenClause;
    }
  | {
      /**
       * Colour picker: a swatch button showing `value(ctx)`; the popup offers `swatches` (theme
       * tokens like `"var(--annot-highlight)"` or PDF-content hex values) and a custom input.
       * Choosing runs `command` with `{ value }`.
       */
      readonly kind: 'color';
      readonly id: string;
      readonly label: string;
      readonly icon?: string;
      readonly command: string;
      readonly value: (ctx: ServiceContext) => string;
      readonly swatches?: ReadonlyArray<RibbonOptionSpec>;
      readonly size?: RibbonItemSize;
      readonly when?: WhenClause;
    }
  | {
      /** Inline text / number / select input; committing runs `command` with `{ value }`. */
      readonly kind: 'input';
      readonly id: string;
      readonly label: string;
      readonly command: string;
      readonly value: (ctx: ServiceContext) => string;
      readonly type?: 'text' | 'number' | 'select';
      readonly options?: ReadonlyArray<RibbonOptionSpec>;
      /** Width in `ch`. */
      readonly width?: number;
      readonly min?: number;
      readonly max?: number;
      readonly step?: number;
      readonly when?: WhenClause;
    };

/** A group of controls on a ribbon tab. */
export interface RibbonGroupSpec {
  /** Unique id, e.g. `"comment.markup"`. */
  readonly id: string;
  /** A built-in tab, or the id of a contextual tab declared in `ModuleManifest.ribbonTabs`. */
  readonly tab: RibbonTabId | (string & {});
  readonly label: string;
  /** Lower first. Groups from different modules interleave by order, then by id. */
  readonly order?: number;
  /**
   * Controls in order. Command ids render as buttons; the literal `"-"` inserts a separator;
   * object items describe richer controls (M02, ADR 0004).
   */
  readonly items: ReadonlyArray<RibbonItemSpec>;
  /** Command ids shown as "large" buttons (the rest render small). */
  readonly large?: ReadonlyArray<string>;
  /** Hides the whole group while false (M02). */
  readonly when?: WhenClause;
}

/**
 * A contextual ribbon tab (M02, ADR 0004) such as "Ink Tools": shown, with its groups, only
 * while `when(ctx)` holds. Groups target it by `RibbonGroupSpec.tab = id`.
 */
export interface RibbonTabSpec {
  /** Unique id, not one of the built-in {@link RibbonTabId}s. */
  readonly id: string;
  readonly label: string;
  readonly when: WhenClause;
  /** Lower first among contextual tabs. */
  readonly order?: number;
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
   * For `dock: 'right'`: the properties pane shows the first panel (by `order`) whose `when`
   * passes and hides itself when none does (M02, ADR 0004). Ignored for other docks.
   */
  readonly when?: WhenClause;
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

/** Status-bar slot. */
export type StatusSlot = 'left' | 'centre' | 'right';

/** A control mounted into the status bar (M02, ADR 0004). */
export interface StatusItemSpec {
  readonly id: string;
  readonly slot: StatusSlot;
  /** Lower first within the slot. */
  readonly order?: number;
  /** Mounts the control into `host`; returns a disposer. */
  mount(host: HTMLElement, ctx: ServiceContext): () => void;
}

/** The fixed list of File-backstage slots, in display order (Foxit 14). */
export type BackstageSlot =
  'open' | 'recent' | 'new' | 'save' | 'saveAs' | 'print' | 'properties' | 'preferences' | 'exit';

/**
 * Fills one backstage slot (M02, ADR 0004). Either `command` (activating the slot runs it and
 * closes the backstage) or `mount` (the slot opens a page rendered into the backstage body).
 */
export interface BackstageSpec {
  readonly slot: BackstageSlot;
  /** Label override; the slot's default name is used when absent. */
  readonly label?: string;
  readonly icon?: string;
  readonly command?: string;
  readonly when?: WhenClause;
  mount?(host: HTMLElement, ctx: ServiceContext): () => void;
}

/** A way to create a new document, shown as a tile on the New page and the empty state. */
export interface CreatorSpec {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly icon?: string;
  readonly command: string;
  readonly order?: number;
  readonly when?: WhenClause;
}

/**
 * Where a context menu contribution applies (M02, ADR 0004): a shell region, `'any'`, or a CSS
 * selector matched against the right-clicked element and its ancestors.
 */
export type ContextMenuRegion =
  'document' | 'tab' | 'left-pane' | 'right-pane' | 'ribbon' | 'any' | (string & {});

/** Right-click menu contribution (M02, ADR 0004). Items are appended in `order`. */
export interface ContextMenuSpec {
  readonly id: string;
  readonly region: ContextMenuRegion;
  readonly items: ReadonlyArray<MenuItemSpec>;
  readonly order?: number;
  readonly when?: WhenClause;
}

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
  /** Contextual ribbon tabs (M02, ADR 0004). */
  readonly ribbonTabs?: ReadonlyArray<RibbonTabSpec>;
  /** Status-bar contributions (M02, ADR 0004). */
  readonly statusBar?: ReadonlyArray<StatusItemSpec>;
  /** File backstage slots this module fills (M02, ADR 0004). */
  readonly backstage?: ReadonlyArray<BackstageSpec>;
  /** "New document" creators listed on the backstage New page and the empty state (M02). */
  readonly creators?: ReadonlyArray<CreatorSpec>;
  /** Right-click menu contributions (M02, ADR 0004). */
  readonly contextMenus?: ReadonlyArray<ContextMenuSpec>;
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
