/**
 * `Registry` — resolves module manifests into the app's command table, palette entries,
 * shortcuts, ribbon groups, panels and tools (M00).
 *
 * ```ts
 * const registry = new Registry();
 * registry.register(viewerManifest);
 * await registry.run('file.open');
 * registry.paletteEntries();   // → sorted, `when`-filtered list for the palette
 * ```
 * Services (document, selection, dialogs, ...) are registered by name so commands can reach
 * them through `ctx.service('selection')` without import cycles.
 */

import type {
  CommandArgs,
  CommandContext,
  CommandSpec,
  ModuleManifest,
  PanelSpec,
  RibbonGroupSpec,
  ServiceContext,
  ShortcutSpec,
  ToolSpec,
} from '@shared/module';

/** A palette row: the command plus its resolved shortcut label. */
export interface PaletteEntry {
  readonly id: string;
  readonly label: string;
  readonly category: string;
  readonly description: string | undefined;
  readonly shortcut: string | undefined;
  readonly module: string;
}

export type RegistryListener = () => void;

export class CommandNotFoundError extends Error {
  constructor(id: string) {
    super(`Unknown command: ${id}`);
    this.name = 'CommandNotFoundError';
  }
}

export class Registry {
  private readonly manifests = new Map<string, ModuleManifest>();
  private readonly commands = new Map<string, { spec: CommandSpec; module: string }>();
  private readonly shortcuts = new Map<string, ShortcutSpec>();
  private readonly services = new Map<string, unknown>();
  private readonly listeners = new Set<RegistryListener>();
  private readonly disposers: (() => void)[] = [];
  private activated = false;

  /** Register a manifest. Duplicate command ids throw — ids are app-wide. */
  register(manifest: ModuleManifest): void {
    if (this.manifests.has(manifest.id)) {
      throw new Error(`Module ${manifest.id} is already registered`);
    }
    for (const cmd of manifest.commands ?? []) {
      if (this.commands.has(cmd.id)) {
        throw new Error(`Command ${cmd.id} (module ${manifest.id}) is already registered`);
      }
    }
    this.manifests.set(manifest.id, manifest);
    for (const cmd of manifest.commands ?? []) {
      this.commands.set(cmd.id, { spec: cmd, module: manifest.id });
      if (cmd.shortcut) this.bindShortcut({ key: cmd.shortcut, command: cmd.id });
    }
    for (const s of manifest.shortcuts ?? []) this.bindShortcut(s);
    for (const tool of manifest.tools ?? []) this.ensureToolCommand(tool, manifest.id);
    for (const panel of manifest.panels ?? []) this.ensurePanelCommand(panel, manifest.id);
    if (this.activated && manifest.activate) {
      const d = manifest.activate(this.context());
      if (d) this.disposers.push(d);
    }
    this.notify();
  }

  /** Calls every manifest's `activate` once the shell is mounted. */
  activateAll(): void {
    if (this.activated) return;
    this.activated = true;
    for (const m of this.manifests.values()) {
      const d = m.activate?.(this.context());
      if (d) this.disposers.push(d);
    }
  }

  /** Runs all disposers returned by `activate`. */
  dispose(): void {
    for (const d of this.disposers.splice(0)) d();
    this.activated = false;
  }

  // ---- services ----------------------------------------------------------------------------

  /** Registers a named service (document, selection, undo, dialogs, ...). */
  provide<T>(name: string, service: T): void {
    this.services.set(name, service);
  }

  /** Looks a service up; throws when missing so failures are loud. */
  service<T>(name: string): T {
    if (!this.services.has(name)) throw new Error(`Unknown service: ${name}`);
    return this.services.get(name) as T;
  }

  hasService(name: string): boolean {
    return this.services.has(name);
  }

  // ---- commands ----------------------------------------------------------------------------

  has(id: string): boolean {
    return this.commands.has(id);
  }

  get(id: string): CommandSpec | undefined {
    return this.commands.get(id)?.spec;
  }

  /** Every registered command, including hidden ones. */
  allCommands(): ReadonlyArray<CommandSpec> {
    return Array.from(this.commands.values(), (c) => c.spec);
  }

  /** True when the command exists and its `when` clause (if any) passes. */
  isEnabled(id: string): boolean {
    const entry = this.commands.get(id);
    if (!entry) return false;
    return entry.spec.when ? entry.spec.when(this.context()) : true;
  }

  /**
   * Runs a command by id. Rejects with `CommandNotFoundError` for unknown ids and with a plain
   * Error when the `when` clause refuses. Resolves with whatever the command returns.
   */
  async run(id: string, args: CommandArgs = {}): Promise<unknown> {
    const entry = this.commands.get(id);
    if (!entry) throw new CommandNotFoundError(id);
    if (!this.isEnabled(id)) throw new Error(`Command ${id} is not available right now`);
    const ctx: CommandContext = { ...this.context(), args };
    return await entry.spec.run(ctx);
  }

  /** Palette rows: visible, enabled commands sorted by category then label. */
  paletteEntries(): PaletteEntry[] {
    const rows: PaletteEntry[] = [];
    for (const { spec, module } of this.commands.values()) {
      if (spec.hidden) continue;
      if (!this.isEnabled(spec.id)) continue;
      rows.push({
        id: spec.id,
        label: spec.label,
        category: spec.category,
        description: spec.description,
        shortcut: this.shortcutFor(spec.id),
        module,
      });
    }
    return rows.sort(
      (a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label),
    );
  }

  // ---- shortcuts ---------------------------------------------------------------------------

  /** Binds a key to a command (later bindings win). */
  bindShortcut(spec: ShortcutSpec): void {
    this.shortcuts.set(normalizeKey(spec.key), spec);
    this.notify();
  }

  /** Looks up the shortcut spec for a normalised key, e.g. `"Mod+Shift+P"`. */
  shortcutForKey(key: string): ShortcutSpec | undefined {
    return this.shortcuts.get(normalizeKey(key));
  }

  /** First key bound to a command, for display. */
  shortcutFor(commandId: string): string | undefined {
    for (const [key, spec] of this.shortcuts) if (spec.command === commandId) return key;
    return undefined;
  }

  allShortcuts(): ReadonlyArray<ShortcutSpec> {
    return Array.from(this.shortcuts.values());
  }

  // ---- ribbon / panels / tools -------------------------------------------------------------

  ribbonGroups(): ReadonlyArray<RibbonGroupSpec> {
    const groups: RibbonGroupSpec[] = [];
    for (const m of this.manifests.values()) groups.push(...(m.ribbon ?? []));
    return groups.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id));
  }

  panels(): ReadonlyArray<PanelSpec> {
    const panels: PanelSpec[] = [];
    for (const m of this.manifests.values()) panels.push(...(m.panels ?? []));
    return panels.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id));
  }

  tools(): ReadonlyArray<ToolSpec> {
    const tools: ToolSpec[] = [];
    for (const m of this.manifests.values()) tools.push(...(m.tools ?? []));
    return tools;
  }

  modules(): ReadonlyArray<ModuleManifest> {
    return Array.from(this.manifests.values());
  }

  // ---- change notification -----------------------------------------------------------------

  subscribe(listener: RegistryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Builds the context handed to commands, `when` clauses, panels and tools. */
  context(): ServiceContext {
    return {
      run: (id, args) => this.run(id, args),
      service: <T>(name: string) => this.service<T>(name),
    };
  }

  private ensureToolCommand(tool: ToolSpec, module: string): void {
    const id = tool.activateCommand ?? `${tool.id}.activate`;
    if (this.commands.has(id)) return;
    const spec: CommandSpec = {
      id,
      label: `Tool: ${tool.label}`,
      category: 'Edit',
      ...(tool.icon !== undefined ? { icon: tool.icon } : {}),
      run: (ctx) => {
        const tools = ctx.service<{ activate(toolId: string): void } | undefined>('tools');
        tools?.activate(tool.id);
      },
    };
    this.commands.set(id, { spec, module });
  }

  private ensurePanelCommand(panel: PanelSpec, module: string): void {
    const id = panel.toggleCommand ?? `panel.${panel.id}`;
    if (this.commands.has(id)) return;
    const spec: CommandSpec = {
      id,
      label: `Toggle panel: ${panel.title}`,
      category: 'View',
      ...(panel.icon !== undefined ? { icon: panel.icon } : {}),
      run: (ctx) => {
        const panels = ctx.service<{ toggle(panelId: string): void } | undefined>('panels');
        panels?.toggle(panel.id);
      },
    };
    this.commands.set(id, { spec, module });
  }

  private notify(): void {
    for (const l of Array.from(this.listeners)) l();
  }
}

/**
 * Normalises a shortcut string: modifiers sorted (`Mod`, `Ctrl`, `Alt`, `Shift`, `Meta`),
 * single letters upper-cased. `"shift+mod+p"` → `"Mod+Shift+P"`.
 */
export function normalizeKey(key: string): string {
  const parts = key.split('+').map((p) => p.trim());
  const keyName = parts.pop() ?? '';
  const order = ['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta'];
  const mods = parts
    .map((m) => {
      const lower = m.toLowerCase();
      if (lower === 'mod' || lower === 'cmdorctrl' || lower === 'commandorcontrol') return 'Mod';
      if (lower === 'ctrl' || lower === 'control') return 'Ctrl';
      if (lower === 'alt' || lower === 'option') return 'Alt';
      if (lower === 'shift') return 'Shift';
      if (lower === 'meta' || lower === 'cmd' || lower === 'command' || lower === 'super')
        return 'Meta';
      return m;
    })
    .sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const k = keyName.length === 1 ? keyName.toUpperCase() : keyName;
  return [...mods, k].join('+');
}

/**
 * Converts a `KeyboardEvent` into the normalised shortcut form, treating Ctrl (Windows/Linux)
 * or Meta (macOS) as `Mod`. Returns `null` for bare modifier presses.
 */
export function keyFromEvent(e: KeyboardEvent, isMac: boolean): string | null {
  const key = e.key;
  if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return null;
  const mods: string[] = [];
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod) mods.push('Mod');
  if (isMac && e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (!isMac && e.metaKey) mods.push('Meta');
  const name = key === ' ' ? 'Space' : key.length === 1 ? key.toUpperCase() : key;
  return normalizeKey([...mods, name].join('+'));
}

/**
 * Formats a normalised shortcut for display: `Mod` becomes `Ctrl` (Windows/Linux) or `⌘`
 * (macOS); `Alt` becomes `⌥` and `Meta` becomes `⌘` on macOS. `"Mod+Shift+P"` → `"Ctrl+Shift+P"`.
 */
export function formatShortcut(key: string, isMac: boolean): string {
  return key
    .split('+')
    .map((part) => {
      if (part === 'Mod') return isMac ? '⌘' : 'Ctrl';
      if (part === 'Meta') return isMac ? '⌘' : 'Win';
      if (part === 'Alt' && isMac) return '⌥';
      return part;
    })
    .join('+');
}
