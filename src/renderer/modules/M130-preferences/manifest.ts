/**
 * M130's manifest — Preferences, the shortcut editor, ribbon and toolbar customisation, the
 * interface font and scale, units, identity and the language switch.
 *
 * The module contributes no ribbon group of its own beyond a small one on Help: Preferences
 * belongs on the File tab, where M02 already draws a Preferences slot, and everything else here
 * is reached from inside that one dialog. Every action is still a registered command with a
 * palette entry, so the whole module is drivable from the keyboard and from the e2e harness.
 *
 * Nothing here changes a *document*, so there are no undoable `Command`s: the module's writes go
 * to `settings.json`, and its Reset is the undo.
 */

import { openDialogElements, type Dialogs } from '@app/dialog/Dialogs';
import type { RibbonHandle } from '@app/ribbon/Ribbon';
import { RIBBON_CUSTOMISATION } from '@app/ribbon/Ribbon';
import { BUILT_IN_TABS } from '@app/ribbon/model';
import { SERVICE, type ShellServices } from '@app/services';
import { registerIcon } from '@app/icons';
import type { Registry } from '@core/Registry';
import { hasBridge, invoke } from '@shared/ipc';
import {
  defineModule,
  type CommandContext,
  type ServiceContext,
  type SettingsSchema,
  type SettingSpec,
} from '@shared/module';
import { THEME_SERVICE } from '@modules/M01-theme-system/manifest';
import type { ThemeManager } from '@theme/ThemeManager';
import { ArrowDown, ArrowUp, FileJson, Languages, Scan } from 'lucide';
import { mountCustomisePage } from './customise/page';
import { UI_FONTS, DEFAULT_UI_FONT } from './fonts';
import { availableLanguages, SOURCE_LANGUAGE, t } from './i18n';
import { openPreferences, type ExtraPage } from './PreferencesDialog';
import { APP_KEYS, PreferencesService, PREFERENCES_SERVICE } from './PreferencesService';
import { buildCheatSheet } from './shortcuts/cheatsheet';
import { mountShortcutEditor } from './shortcuts/editor';
import {
  buildRows,
  buildShortcutExport,
  parseShortcutExport,
  ShortcutImportError,
  type BindableCommand,
} from './shortcuts/model';
import { SettingsImportError } from '@shared/settings';
import { UNITS_SERVICE, unitsSetting } from './units';
import './preferences.css';

// Icons M130 needs that the shell's set does not carry yet (Lucide, ISC — same as every other).
registerIcon('scan', Scan);
registerIcon('arrow-up', ArrowUp);
registerIcon('arrow-down', ArrowDown);
registerIcon('languages', Languages);
registerIcon('file-json', FileJson);

/** Page ids for the three pages in Preferences that are not generated from a schema. */
export const PAGE_SHORTCUTS = 'shortcuts';
export const PAGE_CUSTOMISE = 'customise';
export const PAGE_FILE = 'settings-file';

const prefs = (ctx: ServiceContext): PreferencesService =>
  ctx.service<PreferencesService>(PREFERENCES_SERVICE);
const shellOf = (ctx: ServiceContext): ShellServices => ctx.service<ShellServices>('shellServices');
const dialogsOf = (ctx: ServiceContext): Dialogs => ctx.service<Dialogs>(SERVICE.dialogs);

/** The identity block, which annotations (M30) and later the signature tools read. */
const IDENTITY_SECTION = 'Identity';

/**
 * M130's own settings.
 *
 * A function, and read through a getter below, because two of these are built out of `t()`:
 * the unit labels and the wording around them change with the language, and a schema captured
 * once at import time would still say "Millimetres" after the reader switched to American
 * English. Every read gets the labels the current language asks for.
 */
function ownProperties(): SettingsSchema['properties'] {
  const properties: Record<string, SettingSpec> = {
    // Declared as `app.identity.*` and written to `identity.*` — see `resources/preferences.json`.
    'identity.name': {
      type: 'string',
      title: t('prefs.identityName', 'Your name'),
      description: t(
        'prefs.identityNameHint',
        'Put on every comment and annotation you make, and on signatures later on.',
      ),
      default: '',
      section: IDENTITY_SECTION,
      keywords: ['author', 'name'],
      live: true,
    },
    'identity.initials': {
      type: 'string',
      title: t('prefs.identityInitials', 'Your initials'),
      description: t(
        'prefs.identityInitialsHint',
        'Used by stamps and initialling. Left empty, they are worked out from the name.',
      ),
      default: '',
      section: IDENTITY_SECTION,
      live: true,
    },
    'identity.email': {
      type: 'string',
      title: t('prefs.identityEmail', 'Email address (optional)'),
      description: t(
        'prefs.identityEmailHint',
        'Only stored in this file and written into comments you export.',
      ),
      default: '',
      section: IDENTITY_SECTION,
      live: true,
    },
    'identity.organisation': {
      type: 'string',
      title: t('prefs.identityOrganisation', 'Organisation (optional)'),
      description: t(
        'prefs.identityOrganisationHint',
        'Appears on signature appearances and in document properties you create.',
      ),
      default: '',
      section: IDENTITY_SECTION,
      live: true,
    },
    language: {
      type: 'enum',
      title: t('prefs.language', 'Language'),
      description: t(
        'prefs.languageHint',
        'The language of the application itself. Documents are not affected.',
      ),
      default: SOURCE_LANGUAGE,
      options: availableLanguages().map((l) => ({ value: l.id, label: l.label })),
      section: 'Language and units',
      keywords: ['language', 'locale', 'spelling'],
      live: true,
    },
    ...unitsSetting(),
    uiFont: {
      type: 'enum',
      title: t('prefs.uiFont', 'Interface font'),
      description: t(
        'prefs.uiFontHint',
        'The typeface used for menus, panels and dialogs. Documents keep their own.',
      ),
      default: DEFAULT_UI_FONT,
      options: UI_FONTS.map((f) => ({ value: f.id, label: f.label })),
      section: 'Interface',
      keywords: ['font', 'typeface', 'readable', 'bigger'],
      live: true,
    },
  };
  // `units` comes from `unitsSetting()`; give it the section this page groups it under.
  const units = properties['units'];
  if (units?.type === 'enum') properties['units'] = { ...units, section: 'Language and units' };
  return properties;
}

const SETTINGS: SettingsSchema = {
  namespace: 'app',
  get properties() {
    return ownProperties();
  },
};

/** Every command the shortcut editor can bind, with the key its module declares. */
function bindableCommands(service: PreferencesService, registry: Registry): BindableCommand[] {
  return registry.allCommands().map((command) => ({
    id: command.id,
    label: command.label,
    category: command.category,
    defaultKey: service.defaultKeyFor(command.id),
    description: command.description,
    hidden: command.hidden === true,
  }));
}

/** The three pages that are not generated from a settings schema. */
function extraPages(ctx: ServiceContext): ExtraPage[] {
  const service = prefs(ctx);
  const shell = shellOf(ctx);
  const dialogs = shell.dialogs;
  const registry = shell.registry;
  return [
    {
      id: PAGE_SHORTCUTS,
      label: t('prefs.pageShortcuts', 'Keyboard shortcuts'),
      icon: 'keyboard',
      description: t(
        'prefs.pageShortcutsLede',
        'Every command in the application, and the keys that run it. Changes take effect at once.',
      ),
      mount: (host) =>
        mountShortcutEditor(host, {
          dialogs,
          isMac: shell.isMac,
          commands: () => bindableCommands(service, registry),
          overrides: () => service.overrides(),
          save: (next) => service.setOverrides(next),
          subscribe: (redraw) =>
            service.settings.subscribe((keys) => {
              if (keys.some((key) => key.startsWith('shortcuts.'))) redraw();
            }),
          cheatSheet: () => ctx.run('app.shortcuts.cheatSheet').then(() => undefined),
          exportBindings: () => ctx.run('app.shortcuts.export').then(() => undefined),
          importBindings: () => ctx.run('app.shortcuts.import').then(() => undefined),
        }),
    },
    {
      id: PAGE_CUSTOMISE,
      label: t('prefs.pageCustomise', 'Ribbon and toolbar'),
      icon: 'sliders-horizontal',
      description: t(
        'prefs.pageCustomiseLede',
        'Choose what appears on the ribbon and on the small toolbar above it.',
      ),
      mount: (host) =>
        mountCustomisePage(host, {
          dialogs,
          tabs: BUILT_IN_TABS.map((tab) => ({ id: tab.id, label: tab.label })),
          groups: () => registry.ribbonGroups(),
          describe: (commandId) => {
            const command = registry.get(commandId);
            return {
              label: command?.label ?? commandId,
              ...(command?.icon !== undefined ? { icon: command.icon } : {}),
            };
          },
          state: () => service.ribbonCustom(),
          save: (next) => service.setRibbonCustom(next),
          qat: () => service.qat(),
          setQat: (ids) => service.setQat(ids),
          addableCommands: () =>
            registry
              .allCommands()
              .filter((c) => c.hidden !== true)
              .map((c) => ({ id: c.id, label: `${c.category}: ${c.label}` }))
              .sort((a, b) => a.label.localeCompare(b.label)),
          resetQat: () => service.resetQat(),
          subscribe: (redraw) =>
            service.settings.subscribe((keys) => {
              if (keys.some((key) => key.startsWith('ui.'))) redraw();
            }),
        }),
    },
    {
      id: PAGE_FILE,
      label: t('prefs.pageFile', 'Settings file'),
      icon: 'file-json',
      description: t(
        'prefs.pageFileLede',
        'Where your settings are kept, and how to take a copy or put one back.',
      ),
      mount: (host) => mountFilePage(host, ctx),
    },
  ];
}

/** The "Settings file" page: the path, import, export and the reset-everything button. */
function mountFilePage(host: HTMLElement, ctx: ServiceContext): () => void {
  const service = prefs(ctx);
  const doc = host.ownerDocument;
  const path = doc.createElement('p');
  path.className = 'prefs-file-path';
  path.textContent = t('prefs.filePathLoading', 'Finding the file…');
  void service.settings.filePath().then((where) => {
    path.textContent =
      where === ''
        ? t('prefs.filePathUnknown', 'The settings file is not available in this window.')
        : where;
  });

  const actions = doc.createElement('div');
  actions.className = 'prefs-file-actions';
  const add = (label: string, command: string, className = 'btn'): void => {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.textContent = label;
    btn.dataset['command'] = command;
    btn.addEventListener('click', () => {
      void ctx.run(command);
    });
    actions.append(btn);
  };
  add(t('prefs.export', 'Export settings…'), 'app.settings.export');
  add(t('prefs.import', 'Import settings…'), 'app.settings.import');
  add(t('prefs.reveal', 'Show it in the file manager'), 'app.settings.reveal');
  add(t('prefs.resetAll', 'Reset every setting…'), 'app.settings.reset', 'btn btn-danger');

  const note = doc.createElement('p');
  note.className = 'prefs-file-note';
  note.textContent = t(
    'prefs.fileNote',
    'An export is a plain JSON file. Importing merges it in: settings the file does not mention keep their current value.',
  );
  host.append(path, actions, note);
  return () => undefined;
}

/** Opens Preferences, or brings the open one to the page/search that was asked for. */
async function showPreferences(
  ctx: CommandContext,
  options: { page?: string; search?: string } = {},
): Promise<string> {
  const shell = shellOf(ctx);
  // Re-read first: this service's cache is not the only writer of `settings.json`, and a value a
  // module changed from its own toolbar since the last read must be the one the dialog shows.
  await prefs(ctx).settings.load();
  const handle = openPreferences({
    dialogs: shell.dialogs,
    settings: prefs(ctx).settings,
    manifests: shell.registry.modules(),
    extraPages: extraPages(ctx),
    ...(options.page !== undefined ? { page: options.page } : {}),
    ...(options.search !== undefined ? { search: options.search } : {}),
    browse: (spec) => browseForPath(spec),
  });
  if (options.page !== undefined) handle.show(options.page);
  if (options.search !== undefined) handle.find(options.search);
  return handle.currentPage;
}

/** The Browse button behind a `path` setting. */
async function browseForPath(spec: Extract<SettingSpec, { type: 'path' }>): Promise<string | null> {
  if (!hasBridge()) return null;
  if (spec.pathKind === 'directory') return invoke('dialog:pickFolder', spec.title);
  const files = await invoke('file:openFilesDialog', {
    title: spec.title,
    multi: false,
    ...(spec.extensions && spec.extensions.length > 0
      ? { filters: [{ name: spec.title, extensions: [...spec.extensions] }] }
      : {}),
  });
  return files[0]?.path ?? null;
}

export default defineModule({
  id: 'M130',
  name: 'Preferences',
  settings: SETTINGS,

  activate(ctx) {
    const registry = ctx.service<Registry>('registry');
    if (registry.hasService(PREFERENCES_SERVICE)) return undefined;
    if (!registry.hasService('shellServices')) return undefined;
    const shell = registry.service<ShellServices>('shellServices');
    const themes = registry.hasService(THEME_SERVICE)
      ? registry.service<ThemeManager>(THEME_SERVICE)
      : null;
    const service = new PreferencesService({ registry, shell, themes });
    registry.provide(PREFERENCES_SERVICE, service);
    registry.provide(SERVICE.settings, service.settings);
    registry.provide(UNITS_SERVICE, service.unitsService());
    registry.provide(RIBBON_CUSTOMISATION, {
      apply: (groups: Parameters<PreferencesService['customiseRibbon']>[0]) =>
        service.customiseRibbon(groups),
    });
    void service.load().catch((error: unknown) => {
      console.warn('M130: settings could not be read', error);
    });
    return undefined;
  },

  commands: [
    {
      id: 'app.preferences',
      label: 'Preferences…',
      category: 'Application',
      icon: 'settings',
      shortcut: 'Mod+K',
      description: 'Every setting in the application, with a search across all of them',
      run: (ctx) => {
        const page = ctx.args['page'];
        const search = ctx.args['search'];
        return showPreferences(ctx, {
          ...(typeof page === 'string' ? { page } : {}),
          ...(typeof search === 'string' ? { search } : {}),
        });
      },
    },
    {
      id: 'app.preferences.close',
      label: 'Close Preferences',
      category: 'Application',
      hidden: true,
      run: () => {
        const dialog = openDialogElements().find((d) => d.id === 'preferences-dialog');
        dialog?.close('close');
        return dialog !== undefined;
      },
    },
    {
      id: 'app.identity.edit',
      label: 'Your name and initials…',
      category: 'Application',
      icon: 'user',
      description: 'The name and initials put on comments, annotations and signatures',
      run: (ctx) => showPreferences(ctx, { page: 'M130' }),
    },
    {
      id: 'app.shortcuts.edit',
      label: 'Keyboard Shortcuts…',
      category: 'Application',
      icon: 'keyboard',
      description: 'See and change the key for every command',
      run: (ctx) => showPreferences(ctx, { page: PAGE_SHORTCUTS }),
    },
    {
      id: 'app.customise.ribbon',
      label: 'Customise the Ribbon and Toolbar…',
      category: 'Application',
      icon: 'sliders-horizontal',
      description: 'Hide, show and reorder ribbon groups, buttons and the quick-access toolbar',
      run: (ctx) => showPreferences(ctx, { page: PAGE_CUSTOMISE }),
    },
    {
      id: 'app.customise.reset',
      label: 'Reset the Ribbon and Toolbar',
      category: 'Application',
      icon: 'refresh-cw',
      description: 'Put every ribbon group, button and toolbar item back',
      run: async (ctx) => {
        const service = prefs(ctx);
        await service.setRibbonCustom({
          hiddenGroups: [],
          hiddenItems: [],
          groupOrder: {},
          itemOrder: {},
        });
        await service.resetQat();
        shellOf(ctx).toasts.show({
          kind: 'success',
          title: t('customise.resetToastTitle', 'Reset'),
          text: t('customise.resetToast', 'The ribbon and the toolbar are back to how they ship.'),
        });
        return true;
      },
    },
    // ---- the font, the language and the units -------------------------------------------------
    // The UI scale is M01's `view.uiScale.set`; Preferences drives it through `ui.scale`, which
    // this module's theme applier hands to the ThemeManager. One command, one owner.
    {
      id: 'app.uiFont.set',
      label: 'Set the Interface Font',
      category: 'View',
      icon: 'type',
      description: 'The typeface used for menus, panels and dialogs',
      run: async (ctx) => {
        const value = ctx.args['value'];
        if (typeof value !== 'string') throw new Error('app.uiFont.set needs { value }');
        await prefs(ctx).settings.write(APP_KEYS.uiFont, value);
        return value;
      },
    },
    {
      id: 'app.language.set',
      label: 'Set the Language',
      category: 'Application',
      icon: 'languages',
      description: 'The language of the application itself',
      run: async (ctx) => {
        const value = ctx.args['value'];
        if (typeof value !== 'string') throw new Error('app.language.set needs { value }');
        await prefs(ctx).settings.write(APP_KEYS.language, value);
        return value;
      },
    },
    {
      id: 'app.units.set',
      label: 'Set the Measurement Units',
      category: 'View',
      icon: 'ruler',
      description: 'Points, millimetres, centimetres or inches, used everywhere lengths are shown',
      run: async (ctx) => {
        const value = ctx.args['value'];
        if (typeof value !== 'string') throw new Error('app.units.set needs { value }');
        const units = prefs(ctx).unitsService();
        await units.set(value as never);
        return prefs(ctx).unit;
      },
    },
    // ---- one setting, for the palette and the e2e harness -------------------------------------
    {
      id: 'app.settings.set',
      label: 'Set a Setting by Name',
      category: 'Developer',
      hidden: true,
      description: 'Writes one settings key. Used by the tests and by help articles.',
      run: async (ctx) => {
        const key = ctx.args['key'];
        if (typeof key !== 'string') throw new Error('app.settings.set needs { key }');
        await prefs(ctx).settings.write(key, ctx.args['value']);
        return prefs(ctx).settings.peek(key);
      },
    },
    {
      id: 'app.settings.get',
      label: 'Read a Setting by Name',
      category: 'Developer',
      hidden: true,
      run: async (ctx) => {
        const key = ctx.args['key'];
        if (typeof key !== 'string') throw new Error('app.settings.get needs { key }');
        return prefs(ctx).settings.read(key);
      },
    },
    // ---- import / export / reset ---------------------------------------------------------------
    {
      id: 'app.settings.export',
      label: 'Export Settings…',
      category: 'Application',
      icon: 'download',
      description: 'Write every setting to a JSON file you can keep or copy to another machine',
      run: async (ctx) => {
        const service = prefs(ctx);
        const text = await service.settings.exportText();
        const path = await service.saveText(
          text,
          'ynotPDF settings.json',
          t('prefs.exportTitle', 'Export settings'),
          t('prefs.jsonFilter', 'Settings file'),
        );
        if (path === null) return null;
        shellOf(ctx).toasts.show({
          kind: 'success',
          title: t('prefs.exported', 'Settings exported'),
          text: path,
        });
        return path;
      },
    },
    {
      id: 'app.settings.import',
      label: 'Import Settings…',
      category: 'Application',
      icon: 'upload',
      description: 'Read a settings file back in, merging it with what is here',
      run: async (ctx) => {
        const service = prefs(ctx);
        const dialogs = dialogsOf(ctx);
        const text =
          typeof ctx.args['text'] === 'string'
            ? ctx.args['text']
            : await service.openText(
                t('prefs.importTitle', 'Import settings'),
                t('prefs.jsonFilter', 'Settings file'),
              );
        if (text === null) return null;
        try {
          const result = await service.settings.importText(text);
          const extra =
            result.dropped.length > 0
              ? ` ${t('prefs.importDropped', '{n} lines were not settings and were left out.', {
                  n: result.dropped.length,
                })}`
              : '';
          shellOf(ctx).toasts.show({
            kind: 'success',
            title: t('prefs.imported', 'Settings imported'),
            text:
              t('prefs.importedCount', '{n} settings were read in.', { n: result.written }) + extra,
          });
          return result.written;
        } catch (error) {
          if (!(error instanceof SettingsImportError)) throw error;
          await dialogs.error(
            t('prefs.importFailed', 'That file could not be used'),
            error.message,
          );
          return null;
        }
      },
    },
    {
      id: 'app.settings.reset',
      label: 'Reset Every Setting…',
      category: 'Application',
      icon: 'refresh-cw',
      description: 'Put every preference in the application back to the way it ships',
      run: async (ctx) => {
        const service = prefs(ctx);
        const confirmed =
          ctx.args['confirm'] === true ||
          (await dialogsOf(ctx).confirm({
            title: t('prefs.resetAllTitle', 'Reset every setting?'),
            text: t(
              'prefs.resetAllText',
              'Every preference — the theme, the interface size, your name, every module — goes back to the way the application ships. Your documents and your recent-files list are not touched, and this cannot be undone.',
            ),
            kind: 'warning',
            confirmLabel: t('prefs.resetAllConfirm', 'Reset everything'),
            danger: true,
          }));
        if (!confirmed) return false;
        await service.settings.reset([]);
        shellOf(ctx).toasts.show({
          kind: 'success',
          title: t('prefs.resetAllDoneTitle', 'Reset'),
          text: t('prefs.resetAllDone', 'Every setting is back to the way it ships.'),
        });
        return true;
      },
    },
    {
      id: 'app.settings.reveal',
      label: 'Show the Settings File',
      category: 'Application',
      icon: 'folder-open',
      description: 'Open the folder holding settings.json',
      run: async (ctx) => {
        const where = await prefs(ctx).settings.filePath();
        if (where === '' || !hasBridge()) return null;
        await invoke('shell:showItemInFolder', where);
        return where;
      },
    },
    // ---- shortcut commands -----------------------------------------------------------------------
    {
      id: 'app.shortcuts.set',
      label: 'Bind a Shortcut',
      category: 'Developer',
      hidden: true,
      description: 'Binds { command } to { key }; a null key unbinds it. Used by the tests.',
      run: async (ctx) => {
        const command = ctx.args['command'];
        const key = ctx.args['key'];
        if (typeof command !== 'string') throw new Error('app.shortcuts.set needs { command }');
        const service = prefs(ctx);
        const registry = shellOf(ctx).registry;
        const rows = buildRows(bindableCommands(service, registry), service.overrides());
        const next = { ...service.overrides() };
        if (key === null) next[command] = null;
        else if (typeof key === 'string') {
          // Same rule as the editor: taking a key takes it from whoever had it.
          const clash = rows.find((r) => r.key === key && r.commandId !== command);
          if (clash) next[clash.commandId] = null;
          next[command] = key;
        } else throw new Error('app.shortcuts.set needs { key } as a string or null');
        await service.setOverrides(next);
        return service.overrides();
      },
    },
    {
      id: 'app.shortcuts.reset',
      label: 'Reset Every Shortcut',
      category: 'Application',
      icon: 'refresh-cw',
      description: 'Put every keyboard shortcut back to the key its module declares',
      run: async (ctx) => {
        await prefs(ctx).setOverrides({});
        return true;
      },
    },
    {
      id: 'app.shortcuts.cheatSheet',
      label: 'Printable Shortcut List',
      category: 'Application',
      icon: 'printer',
      description: 'A PDF listing every command and its key, ready to print',
      run: async (ctx) => {
        const service = prefs(ctx);
        const shell = shellOf(ctx);
        const rows = buildRows(
          bindableCommands(service, shell.registry).filter((c) => !c.hidden),
          service.overrides(),
        );
        const sheet = await buildCheatSheet(rows, { isMac: shell.isMac });
        await ctx.run('file.openBytes', {
          file: { path: '', name: sheet.fileName, bytes: sheet.bytes },
        });
        return {
          pageCount: sheet.pageCount,
          commandCount: sheet.commandCount,
          boundCount: sheet.boundCount,
          name: sheet.fileName,
        };
      },
    },
    {
      id: 'app.shortcuts.export',
      label: 'Export Shortcuts…',
      category: 'Application',
      icon: 'download',
      description: 'Write the shortcuts you have changed to a JSON file',
      run: async (ctx) => {
        const service = prefs(ctx);
        const text = `${JSON.stringify(buildShortcutExport(service.overrides()), null, 2)}\n`;
        const path = await service.saveText(
          text,
          'ynotPDF shortcuts.json',
          t('shortcuts.exportTitle', 'Export shortcuts'),
          t('shortcuts.jsonFilter', 'Shortcut file'),
        );
        if (path === null) return null;
        shellOf(ctx).toasts.show({
          kind: 'success',
          title: t('shortcuts.exported', 'Shortcuts exported'),
          text: path,
        });
        return path;
      },
    },
    {
      id: 'app.shortcuts.import',
      label: 'Import Shortcuts…',
      category: 'Application',
      icon: 'upload',
      description: 'Read a shortcut file back in',
      run: async (ctx) => {
        const service = prefs(ctx);
        const shell = shellOf(ctx);
        const text =
          typeof ctx.args['text'] === 'string'
            ? ctx.args['text']
            : await service.openText(
                t('shortcuts.importTitle', 'Import shortcuts'),
                t('shortcuts.jsonFilter', 'Shortcut file'),
              );
        if (text === null) return null;
        try {
          const known = new Set(shell.registry.allCommands().map((c) => c.id));
          const result = parseShortcutExport(text, known);
          await service.setOverrides(result.bindings);
          const notes: string[] = [
            t('shortcuts.importedCount', '{n} shortcuts were read in.', {
              n: Object.keys(result.bindings).length,
            }),
          ];
          if (result.unknown.length > 0) {
            notes.push(
              t('shortcuts.importedUnknown', '{n} were for commands this build does not have.', {
                n: result.unknown.length,
              }),
            );
          }
          if (result.invalid.length > 0) {
            notes.push(
              t('shortcuts.importedInvalid', '{n} were not usable keys.', {
                n: result.invalid.length,
              }),
            );
          }
          shell.toasts.show({
            kind: 'success',
            title: t('shortcuts.imported', 'Shortcuts imported'),
            text: notes.join(' '),
          });
          return Object.keys(result.bindings).length;
        } catch (error) {
          if (!(error instanceof ShortcutImportError)) throw error;
          await dialogsOf(ctx).error(
            t('shortcuts.importFailed', 'That file could not be used'),
            error.message,
          );
          return null;
        }
      },
    },
  ],

  /** Preferences also belongs where Foxit puts the rest of the set-up: the Help tab. */
  ribbon: [
    {
      id: 'app.preferences',
      tab: 'help',
      label: 'Set up',
      order: 20,
      items: [
        'app.preferences',
        'app.shortcuts.edit',
        'app.customise.ribbon',
        '-',
        'app.shortcuts.cheatSheet',
      ],
      large: ['app.preferences'],
    },
  ],

  /** M02 draws a Preferences slot on the File tab; this is what fills it. */
  backstage: [{ slot: 'preferences', command: 'app.preferences', icon: 'settings' }],

  /** Mod+, is the other convention for this dialog, and costs nothing to honour. */
  shortcuts: [{ key: 'Mod+,', command: 'app.preferences', scope: 'global' }],

  contextMenus: [
    {
      id: 'app.preferences.ribbon',
      region: 'ribbon',
      order: 90,
      items: ['-', 'app.customise.ribbon', 'app.shortcuts.edit', 'app.preferences'],
    },
  ],
});

/** The live service, for another module that needs it before its own activation. */
export function preferencesService(registry: Registry): PreferencesService | null {
  return registry.hasService(PREFERENCES_SERVICE)
    ? registry.service<PreferencesService>(PREFERENCES_SERVICE)
    : null;
}

/** Exported for the tests: what {@link RibbonHandle} the customisation service talks to. */
export type { RibbonHandle };
