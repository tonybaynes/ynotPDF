/**
 * M100 manifest — reduce file size, optimise, audit space, repair, and fast web view.
 *
 * Every one is a registered command, so it is in the command palette, the e2e suite can drive it
 * by id, and the ribbon and the File backstage are two views of one list rather than two
 * implementations. The commands themselves are thin: they read their arguments, ask a dialog when
 * there is something to ask, and call `OptimiseService`.
 *
 * Arguments let every command be driven without a dialog in the way, which is how the tests run
 * them: `optimise.reduce` accepts `{ preset, path, target }`, `optimise.repair` accepts
 * `{ path }`, and `optimise.check` takes nothing and answers with what qpdf said.
 *
 * **M100 registers no undoable `Command`, and that is not an oversight.** Optimising produces a
 * *file*; it never changes the open document's model, for the reasons `OptimiseService` sets out.
 * The one thing it changes about an open document is a setting — whether saves are linearised —
 * which is not a document change either.
 */

import { registerIcon } from '@app/icons';
import type { ShellServices } from '@app/services';
import type { Registry } from '@core/Registry';
import { defineModule, type CommandContext, type ServiceContext } from '@shared/module';
import { hasBridge, invoke } from '@shared/ipc';
import { isCancelled, type OptimiseOptions } from '@engine/optimise';
import { ChartPie, FileArchive, Gauge, Minimize2, Wrench } from 'lucide';
import { SAVE_SERVICE, type SaveService } from '@modules/M21-save/SaveService';
import type { Document } from '@core/Document';
import {
  OPTIMISE_SERVICE,
  OptimiseService,
  REPAIR_SERVICE,
  type OptimiseOutcome,
} from './OptimiseService';
import { askOptimise, type OptimiseTarget } from './optimiseDialog';
import { auditView, formatBytes, savingLine } from './auditView';
import { OPTIMISE_SETTINGS_SCHEMA } from './settings';
import { el } from '@app/dom';
import './optimise.css';

registerIcon('file-archive', FileArchive);
registerIcon('minimize-2', Minimize2);
registerIcon('wrench', Wrench);
registerIcon('chart-pie', ChartPie);
registerIcon('gauge', Gauge);

/** The live service while the module is activated. Exposed for the unit tests, as M41 does. */
let live: OptimiseService | null = null;

export function activeOptimiseService(): OptimiseService | null {
  return live;
}

function service(ctx: ServiceContext): OptimiseService {
  return ctx.service<OptimiseService>(OPTIMISE_SERVICE);
}

function shell(ctx: ServiceContext): ShellServices {
  return ctx.service<ShellServices>('shellServices');
}

/** Whether what M02 attached to a tab is a `Document` and not some other module's state. */
function isDocument(value: unknown): value is Document {
  return typeof value === 'object' && value !== null && 'state' in value && 'engine' in value;
}

/** A document is open. Everything in this module needs one. */
function open(ctx: ServiceContext): boolean {
  return ctx.service<OptimiseService>(OPTIMISE_SERVICE).document !== null;
}

/** `"<name> (optimised).pdf"` from a path or a title. */
export function optimisedName(from: string): string {
  const base = from.replace(/\\/g, '/').split('/').pop() ?? from;
  const stem = base.replace(/\.pdf$/i, '');
  return `${stem} (optimised).pdf`;
}

/** `"<name> (repaired).pdf"`, likewise. */
export function repairedName(from: string): string {
  const base = from.replace(/\\/g, '/').split('/').pop() ?? from;
  const stem = base.replace(/\.pdf$/i, '');
  return `${stem} (repaired).pdf`;
}

export default defineModule({
  id: 'M100',
  name: 'Optimise and repair',
  settings: OPTIMISE_SETTINGS_SCHEMA,

  activate(ctx) {
    const registry = ctx.service<Registry>('registry');
    if (!registry.hasService('shellServices')) return undefined;
    // `Registry.dispose()` runs the disposers but leaves the services registered, so a
    // dispose-then-activate cycle arrives here with the service still in place (M40's note).
    const existing = registry.hasService(OPTIMISE_SERVICE)
      ? registry.service<OptimiseService>(OPTIMISE_SERVICE)
      : null;
    const services = registry.service<ShellServices>('shellServices');
    const optimise = existing ?? new OptimiseService({ registry, shell: services });
    live = optimise;
    if (existing === null) {
      registry.provide(OPTIMISE_SERVICE, optimise);
      // The name M11's open path looks for (ADR 0019 §2). Registering it is what turns "this file
      // is damaged" from an error toast into an offer.
      registry.provide(REPAIR_SERVICE, optimise);
      void optimise.load();
    }

    const disposers: Array<() => void> = [];

    // Fast web view on save, when the reader has asked for it (ADR 0019 §3).
    if (registry.hasService(SAVE_SERVICE)) {
      const saves = registry.service<SaveService>(SAVE_SERVICE);
      const handlesSecurity = (documentId: string): boolean => {
        if (!registry.hasService('security')) return false;
        const security = registry.service<{ willProtect?(id: string): boolean }>('security');
        return security.willProtect?.(documentId) ?? false;
      };
      disposers.push(saves.addStage(optimise.stage(handlesSecurity)));
    }

    // "This file is damaged" for a file that opened anyway. A toast, not a dialog: it opened.
    disposers.push(
      services.documents.onAttached((_tab, value) => {
        if (!isDocument(value)) return;
        void optimise.checkOnOpen(value).catch(() => undefined);
      }),
    );

    return () => {
      for (const dispose of disposers) dispose();
      live = null;
    };
  },

  ribbon: [
    {
      id: 'optimise.file',
      tab: 'convert',
      label: 'Optimise',
      order: 40,
      items: [
        { kind: 'button', command: 'optimise.reduce', size: 'large' },
        'optimise.audit',
        'optimise.check',
        'optimise.repair',
      ],
    },
  ],

  backstage: [
    {
      slot: 'save',
      label: 'Reduce File Size…',
      icon: 'minimize-2',
      command: 'optimise.reduce',
      when: open,
    },
  ],

  contextMenus: [
    {
      id: 'optimise.document',
      region: 'document',
      order: 70,
      when: open,
      items: [{ label: 'Reduce File Size…', command: 'optimise.reduce', icon: 'minimize-2' }],
    },
  ],

  commands: [
    {
      id: 'optimise.reduce',
      label: 'Reduce File Size…',
      category: 'Convert',
      icon: 'minimize-2',
      shortcut: 'Mod+Alt+O',
      description:
        'Make a smaller copy of this document: downsample pictures, cut fonts down, merge ' +
        'duplicates and repack the file. The original is not touched.',
      when: open,
      permission: 'modify',
      run: (ctx) => reduce(ctx),
    },
    {
      id: 'optimise.audit',
      label: 'Where the File’s Size Is',
      category: 'Convert',
      icon: 'chart-pie',
      description: 'A breakdown of this document by what its bytes are spent on.',
      when: open,
      run: (ctx) => audit(ctx),
    },
    {
      id: 'optimise.check',
      label: 'Check This Document',
      category: 'Convert',
      icon: 'gauge',
      description: 'Read the file thoroughly and say whether anything is wrong with it.',
      when: open,
      run: (ctx) => check(ctx),
    },
    {
      id: 'optimise.repair',
      label: 'Repair a Copy…',
      category: 'Convert',
      icon: 'wrench',
      description:
        'Rebuild a damaged document from what can still be read of it, and save the rebuilt copy ' +
        'as a new file.',
      when: open,
      run: (ctx) => repair(ctx),
    },
    {
      id: 'optimise.fastWebView.toggle',
      label: 'Optimise Saved Files for Fast Web View',
      category: 'Convert',
      icon: 'file-archive',
      description:
        'Puts the first page at the front of every file you save, so it appears before the rest ' +
        'has downloaded.',
      run: async (ctx) => {
        const s = service(ctx);
        const wanted = ctx.args['on'];
        const next = typeof wanted === 'boolean' ? wanted : !s.settings.linearizeOnSave;
        await s.setSetting('linearizeOnSave', next);
        return next;
      },
    },
  ],

  shortcuts: [],
});

// ---- the commands, in full ---------------------------------------------------------------------

/**
 * Reduce File Size.
 *
 * The dialog runs the whole pipeline over a copy to show the reader a size they can trust, and
 * keeps those bytes — so pressing Optimise writes exactly what was promised rather than doing the
 * work a second time and possibly landing somewhere else.
 */
async function reduce(ctx: CommandContext): Promise<OptimiseOutcome | null> {
  const s = service(ctx);
  const doc = s.require();
  const bytes = await s.sourceBytes(doc);
  const services = shell(ctx);

  const presetArg = ctx.args['preset'];
  const pathArg = ctx.args['path'];
  const targetArg = ctx.args['target'];

  let options: OptimiseOptions;
  let target: OptimiseTarget = targetArg === 'replace' ? 'replace' : 'new-file';
  let result = null as Awaited<ReturnType<OptimiseService['run']>>;

  if (typeof presetArg === 'string') {
    // Driven by arguments — the palette, a shortcut, the e2e harness. No dialog.
    const preset = s.preset(presetArg);
    if (!preset) throw new Error(`No such optimise preset: ${presetArg}`);
    options = preset.options;
    result = await s.run(bytes, options);
  } else {
    const choice = await askOptimise({
      dialogs: s.dialogs,
      presets: s.presets,
      presetId: s.settings.preset,
      name: doc.state.title,
      size: bytes.length,
      hasPath: doc.state.path !== null,
      preview: (o) => s.run(bytes, o),
      audit: () => s.audit(bytes),
      savePreset: async (name, o) => {
        await s.savePreset({
          id: `custom-${String(Date.now())}`,
          name,
          description: 'Your own settings.',
          lossless: false,
          builtIn: false,
          options: o,
        });
      },
    });
    if (!choice) return null;
    options = choice.options;
    target = choice.target;
    result = choice.result ?? (await s.run(bytes, options));
    if (choice.presetId !== 'custom') await s.setSetting('preset', choice.presetId);
  }

  if (!result) return null;

  const path = await chooseDestination(s, doc.state.path, doc.state.title, target, pathArg);
  if (path === null) return null;

  if (target === 'replace' && s.settings.confirmReplace && typeof pathArg !== 'string') {
    const agreed = await s.dialogs.confirm({
      title: 'Replace the open file?',
      text:
        `${savingLine(result.before, result.after)}\n\n` +
        'The optimised copy will be written over the file this document came from, and the ' +
        'document will be reloaded — which clears the undo history.',
      confirmLabel: 'Replace it',
      cancelLabel: 'Cancel',
      danger: true,
      kind: 'warning',
    });
    if (!agreed) return null;
  }

  const outcome = await s.writeResult(result, path);
  const sameFile = path === doc.state.path;
  services.toasts.show({
    kind: outcome.after < outcome.before ? 'success' : 'info',
    title: 'Optimised',
    text: `${savingLine(outcome.before, outcome.after)} — ${path}`,
    actions: sameFile
      ? []
      : [
          {
            label: 'Open it',
            run: async () => {
              await s.openBytes(optimisedName(path), result.bytes, path);
            },
          },
        ],
  });
  for (const warning of outcome.warnings) {
    services.toasts.show({ kind: 'warning', title: 'Optimise', text: warning });
  }
  if (sameFile) {
    // The file under the open document has changed; M21's watcher offers the reload, and its
    // wording about what a reload costs is the wording this needs.
    services.toasts.show({
      kind: 'info',
      title: 'Reload',
      text: 'The file this document came from has been replaced. Reload it to see the optimised copy.',
    });
  }
  return outcome;
}

/** Where the optimised copy goes. `null` when the reader cancelled the OS dialog. */
async function chooseDestination(
  s: OptimiseService,
  currentPath: string | null,
  title: string,
  target: OptimiseTarget,
  pathArg: unknown,
): Promise<string | null> {
  if (typeof pathArg === 'string' && pathArg !== '') return pathArg;
  if (target === 'replace' && currentPath !== null) return currentPath;
  if (!hasBridge()) throw new Error('Saving needs the app shell');
  return invoke('file:saveAsDialog', {
    defaultPath: optimisedName(currentPath ?? title),
    title: 'Save the optimised PDF as',
    buttonLabel: 'Save',
  });
}

/** The space audit, as a dialog of its own — the same view the Optimise dialog's last tab shows. */
async function audit(ctx: CommandContext): Promise<Record<string, number>> {
  const s = service(ctx);
  const doc = s.require();
  const bytes = await s.sourceBytes(doc);
  const result = await s.audit(bytes);
  const body = el('div.opt-audit-dialog');
  body.append(
    el('p.field-hint', null, `${doc.state.title} — ${formatBytes(result.total)} in total.`),
    auditView(result),
  );
  await s.dialogs.open({
    id: 'optimise-audit',
    title: 'Where the file’s size is',
    width: 680,
    content: body,
    buttons: [{ id: 'ok', label: 'Close', primary: true }],
  }).result;
  return Object.fromEntries(result.slices.map((slice) => [slice.category, slice.bytes]));
}

/** Check This Document: what qpdf makes of the file, said in words. */
async function check(ctx: CommandContext): Promise<Record<string, unknown> | null> {
  const s = service(ctx);
  const doc = s.require();
  const bytes = await s.sourceBytes(doc);
  const result = await s.check(bytes);
  if (!result) {
    await s.dialogs.info('Cannot check', 'Checking a document needs the app shell.');
    return null;
  }
  const problems = [...result.errors, ...result.warnings];
  if (result.ok) {
    await s.dialogs.message({
      kind: 'success',
      title: 'Nothing wrong',
      text:
        `${doc.state.title} reads correctly from end to end. ` +
        `PDF version ${result.version ?? 'unknown'}; ` +
        `fast web view is ${result.linearised ? 'on' : 'off'}.`,
    });
  } else {
    const answer = await s.dialogs.message({
      kind: 'warning',
      title: 'This file has damage in it',
      text: `${doc.state.title}: ${problems[0] ?? 'qpdf found something wrong with this file.'}`,
      ...(problems.length > 1 ? { detail: problems.slice(1).join('\n') } : {}),
      buttons: [
        { id: 'repair', label: 'Repair a copy…', primary: true },
        { id: 'ok', label: 'Close' },
      ],
    });
    if (answer === 'repair') await ctx.run('optimise.repair');
  }
  return { ...result };
}

/** Repair a copy: rebuild the document and write it out as a new file. */
async function repair(ctx: CommandContext): Promise<{ path: string } | null> {
  const s = service(ctx);
  const doc = s.require();
  const services = shell(ctx);
  const bytes = await s.sourceBytes(doc);
  const found = await s.check(bytes).catch(() => null);

  if (found?.ok === true) {
    const anyway = await s.dialogs.confirm({
      title: 'Nothing to repair',
      text: `${doc.state.title} reads correctly from end to end. A repaired copy would be the same document rewritten.`,
      confirmLabel: 'Rebuild it anyway',
      cancelLabel: 'Leave it',
    });
    if (!anyway) return null;
  }

  let repaired;
  try {
    repaired = await s.repair(bytes, found?.errors ?? []);
  } catch (error) {
    if (isCancelled(error)) return null;
    await s.dialogs.error(
      'Could not repair',
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }

  const pathArg = ctx.args['path'];
  const path =
    typeof pathArg === 'string' && pathArg !== ''
      ? pathArg
      : hasBridge()
        ? await invoke('file:saveAsDialog', {
            defaultPath: repairedName(doc.state.path ?? doc.state.title),
            title: 'Save the repaired PDF as',
            buttonLabel: 'Save',
          })
        : null;
  if (path === null) return null;

  await invoke('file:writeAtomic', path, repaired.bytes, { backup: false });
  services.toasts.show({
    kind: 'success',
    title: 'Repaired',
    text: `A rebuilt copy was saved as ${path}. Check it against the original before you rely on it.`,
    actions: [
      {
        label: 'Open it',
        run: async () => {
          await s.openBytes(repairedName(path), repaired.bytes, path);
        },
      },
    ],
  });
  for (const warning of repaired.warnings) {
    services.toasts.show({ kind: 'warning', title: 'Repair', text: warning });
  }
  return { path };
}
