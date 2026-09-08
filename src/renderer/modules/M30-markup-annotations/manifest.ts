/**
 * M30 manifest — text markup, notes, typewriter, text box and callout.
 *
 * Everything a reader can do here is a registered command, so it is in the command palette, the
 * e2e suite drives it by id rather than by pixel, and M130's shortcut editor can rebind it. The
 * developer probes at the bottom are how the acceptance tests read the annotation model, the
 * selection and the generated appearance out of the running app.
 */

import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Highlighter,
  Italic,
  MessageSquareQuote,
  MousePointer2,
  Replace,
  SpellCheck,
  Strikethrough,
  Type,
  Underline as UnderlineIcon,
} from 'lucide';
import { registerIcon } from '@app/icons';
import type { ShellServices } from '@app/services';
import { SERVICE } from '@app/services';
import type { Registry } from '@core/Registry';
import type { ModelId } from '@core/Ids';
import type { EngineClient } from '@engine/EngineClient';
import { appearanceInput, defaultAppearanceService, intentOf, styleOf } from '@engine/appearance';
import { defineModule, type CommandSpec, type ServiceContext } from '@shared/module';
import { AnnotationService, ANNOTATION_SERVICE, PROPERTIES_PANEL_ID } from './AnnotationService';
import { AnnotationController } from './AnnotationController';
import { openInlineEditor, type InlineEditorHandle } from './InlineEditor';
import { openNotePopup, type NotePopupHandle } from './NotePopup';
import { mountPropertiesPanel } from './PropertiesPanel';
import { drawnByOverlay, isOurs } from './shapes';
import { ANNOTATION_SETTINGS_SCHEMA, type AnnotationToolId } from './settings';
import {
  annotationTools,
  CALLOUT_TOOL,
  NOTE_TOOL,
  SELECT_ANNOTATION_TOOL,
  TEXTBOX_TOOL,
  TYPEWRITER_TOOL,
} from './tools';

export { AnnotationService, ANNOTATION_SERVICE, PROPERTIES_PANEL_ID } from './AnnotationService';

/*
 * Registered at module scope, not in `activate`: the ribbon is built when the shell mounts, which
 * is before manifests are activated, so an icon registered later paints as a placeholder on the
 * first frame — the trap M13 documented and `test/e2e/shell.spec.ts` fails on.
 */
registerIcon('highlighter', Highlighter);
registerIcon('underline', UnderlineIcon);
registerIcon('strikethrough', Strikethrough);
registerIcon('spell-check', SpellCheck);
registerIcon('replace', Replace);
registerIcon('type', Type);
registerIcon('message-square-quote', MessageSquareQuote);
registerIcon('mouse-pointer-2', MousePointer2);
registerIcon('bold', Bold);
registerIcon('italic', Italic);
registerIcon('align-left', AlignLeft);
registerIcon('align-center', AlignCenter);
registerIcon('align-right', AlignRight);

/** The tools are handed to the Registry before `activate` builds the service. */
let live: AnnotationService | null = null;
const lookup = (): AnnotationService | null => live;

const service = (ctx: ServiceContext): AnnotationService =>
  ctx.service<AnnotationService>(ANNOTATION_SERVICE);

const hasService = (ctx: ServiceContext): boolean =>
  ctx.service<Registry>('registry').hasService(ANNOTATION_SERVICE);

/** A document is open. */
const open = (ctx: ServiceContext): boolean =>
  hasService(ctx) && service(ctx).activeDocument() !== null;

/** Text is selected, which is what the markup tools act on. */
const textSelected = (ctx: ServiceContext): boolean => {
  if (!open(ctx)) return false;
  return ctx.service<{ current: { kind: string } }>('selection').current.kind === 'text';
};

/** At least one annotation is selected. */
const annotationSelected = (ctx: ServiceContext): boolean =>
  hasService(ctx) && service(ctx).selection.length > 0;

function toolIs(id: string): (ctx: ServiceContext) => boolean {
  return (ctx) =>
    ctx.service<{ get(): { activeTool: string | null } }>('ui').get().activeTool === id;
}

/**
 * A markup command: switch to Select Text so the reader can simply drag, then mark whatever is
 * selected. That two-step is what Foxit does, and it is why the markup tools are commands rather
 * than `ToolSpec`s — M13 already owns selecting words, and a second implementation would disagree
 * with it about where a word ends.
 */
function markupCommand(spec: {
  id: string;
  label: string;
  icon: string;
  keyTip: string;
  shortcut?: string;
  subtype: 'Highlight' | 'Underline' | 'Squiggly' | 'StrikeOut';
  tool: AnnotationToolId;
  description: string;
}): CommandSpec {
  return {
    id: spec.id,
    label: spec.label,
    category: 'Comment',
    icon: spec.icon,
    keyTip: spec.keyTip,
    ...(spec.shortcut ? { shortcut: spec.shortcut } : {}),
    description: spec.description,
    permission: 'annotate',
    when: open,
    run: async (ctx) => {
      const s = service(ctx);
      const made = await s.createMarkup(spec.subtype, spec.tool);
      if (made.length === 0) {
        // Nothing was selected: leave the reader in the tool that selects text, which is what
        // they need next, rather than saying "nothing happened".
        ctx.service<{ activate(id: string): void }>(SERVICE.tools).activate('tool.selectText');
      }
      return made;
    },
  };
}

export default defineModule({
  id: 'M30',
  name: 'Annotations',

  activate(ctx) {
    const registry = ctx.service<Registry>('registry');
    if (registry.hasService(ANNOTATION_SERVICE)) return undefined;
    const shell = registry.service<ShellServices>('shellServices');
    const host = document.getElementById('doc-host');
    if (!host) return undefined;
    const engine = registry.service<EngineClient>('engineClient').engine;
    const annotations = new AnnotationService({ registry, shell, engine });
    live = annotations;
    registry.provide(ANNOTATION_SERVICE, annotations);

    let popup: NotePopupHandle | null = null;
    let editor: InlineEditorHandle | null = null;
    annotations.bindOpeners(
      (id) => {
        popup?.close(true);
        popup = openNotePopup(annotations, id, host);
      },
      (id) => {
        editor?.close(true);
        editor = openInlineEditor(annotations, id, { deleteIfEmpty: true });
      },
    );
    const controller = new AnnotationController({ service: annotations, shell, host });
    void annotations.load();
    return () => {
      live = null;
      popup?.close(false);
      editor?.close(false);
      controller.dispose();
      annotations.dispose();
    };
  },

  tools: annotationTools(lookup),

  settings: ANNOTATION_SETTINGS_SCHEMA,

  panels: [
    {
      id: PROPERTIES_PANEL_ID,
      title: 'Annotation',
      dock: 'right',
      icon: 'message-square',
      /*
       * Order 0, so a panel bound to the **selection** outranks one bound to the document. M02's
       * rule is "the first right-dock panel by order whose `when` passes", and a document-wide
       * panel's `when` is true all the time — the e2e demo module has exactly such a panel at
       * order 2, and M72's document properties will be another. Neither should hide the
       * properties of the thing the reader has just clicked on.
       */
      order: 0,
      when: annotationSelected,
      mount: (element, context) => mountPropertiesPanel(element, service(context)),
    },
  ],

  commands: [
    // ---- text markup ----------------------------------------------------------------------------
    markupCommand({
      id: 'annot.highlight',
      label: 'Highlight',
      icon: 'highlighter',
      keyTip: 'H',
      shortcut: 'Mod+Alt+H',
      subtype: 'Highlight',
      tool: 'highlight',
      description: 'Highlight the selected text',
    }),
    markupCommand({
      id: 'annot.underline',
      label: 'Underline',
      icon: 'underline',
      keyTip: 'U',
      shortcut: 'Mod+Alt+U',
      subtype: 'Underline',
      tool: 'underline',
      description: 'Underline the selected text',
    }),
    markupCommand({
      id: 'annot.squiggly',
      label: 'Squiggly',
      icon: 'spell-check',
      keyTip: 'Q',
      subtype: 'Squiggly',
      tool: 'squiggly',
      description: 'Mark the selected text with a wavy underline',
    }),
    markupCommand({
      id: 'annot.strikeout',
      label: 'Strikeout',
      icon: 'strikethrough',
      keyTip: 'K',
      shortcut: 'Mod+Alt+K',
      subtype: 'StrikeOut',
      tool: 'strikeout',
      description: 'Strike through the selected text',
    }),
    {
      id: 'annot.replace',
      label: 'Replace Text',
      category: 'Comment',
      icon: 'replace',
      keyTip: 'R',
      description: 'Strike the selected text through and add a mark holding its replacement',
      permission: 'annotate',
      when: textSelected,
      run: (ctx) => service(ctx).createReplace(),
    },
    {
      id: 'annot.insert',
      label: 'Insert Text',
      category: 'Comment',
      icon: 'text-cursor-input',
      keyTip: 'I',
      description: 'Mark where text should be inserted, and what it should say',
      permission: 'annotate',
      when: textSelected,
      run: (ctx) => service(ctx).createInsert(),
    },

    // ---- notes and free text --------------------------------------------------------------------
    {
      id: 'annot.note',
      label: 'Note',
      category: 'Comment',
      icon: 'message-square',
      keyTip: 'N',
      description: 'Place a sticky note; click the page to put it down',
      permission: 'annotate',
      when: open,
      run: (ctx) => {
        // `{ page, x, y }` places one straight away, which is how the e2e suite drives it.
        const s = service(ctx);
        const page = ctx.args['page'];
        const x = ctx.args['x'];
        const y = ctx.args['y'];
        if (typeof page === 'number' && typeof x === 'number' && typeof y === 'number') {
          return s.createNote(page, { x, y });
        }
        ctx.service<{ activate(id: string): void }>(SERVICE.tools).activate(NOTE_TOOL);
        return null;
      },
    },
    ...(
      [
        {
          id: 'annot.typewriter',
          label: 'Typewriter',
          icon: 'type',
          keyTip: 'T',
          tool: TYPEWRITER_TOOL,
          kind: 'typewriter' as const,
          description: 'Type straight on to the page, with no box around the words',
        },
        {
          id: 'annot.textbox',
          label: 'Text Box',
          icon: 'square-pen',
          keyTip: 'X',
          tool: TEXTBOX_TOOL,
          kind: 'textbox' as const,
          description: 'Draw a bordered box and type in it',
        },
        {
          id: 'annot.callout',
          label: 'Callout',
          icon: 'message-square-quote',
          keyTip: 'C',
          tool: CALLOUT_TOOL,
          kind: 'callout' as const,
          description: 'A text box with a leader line pointing at what it is about',
        },
      ] as const
    ).map((spec): CommandSpec => ({
      id: spec.id,
      label: spec.label,
      category: 'Comment',
      icon: spec.icon,
      keyTip: spec.keyTip,
      description: spec.description,
      permission: 'annotate',
      when: open,
      run: async (ctx) => {
        const s = service(ctx);
        const page = ctx.args['page'];
        const rect = ctx.args['rect'];
        if (typeof page === 'number' && isRect(rect)) {
          return await s.createFreeText(spec.kind, page, rect, calloutArg(ctx.args['callout']));
        }
        ctx.service<{ activate(id: string): void }>(SERVICE.tools).activate(spec.tool);
        return null;
      },
    })),

    // ---- selection and editing ---------------------------------------------------------------
    {
      id: 'annot.selectAll',
      label: 'Select All Comments on This Page',
      category: 'Comment',
      icon: 'mouse-pointer-2',
      description: 'Select every comment on the page you are looking at',
      when: open,
      run: (ctx) => {
        service(ctx).selectAllOnPage();
      },
    },
    {
      id: 'annot.deselect',
      label: 'Deselect Comments',
      category: 'Comment',
      description: 'Clear the comment selection',
      when: annotationSelected,
      run: (ctx) => {
        service(ctx).clearSelection();
      },
    },
    {
      id: 'annot.delete',
      label: 'Delete Comment',
      category: 'Comment',
      icon: 'trash-2',
      description: 'Delete the selected comments',
      permission: 'annotate',
      when: annotationSelected,
      run: (ctx) => service(ctx).deleteSelection(),
    },
    {
      id: 'annot.copy',
      label: 'Copy Comment',
      category: 'Comment',
      icon: 'copy',
      description: 'Copy the selected comments, to paste into this or another document',
      when: annotationSelected,
      run: (ctx) => service(ctx).copySelection(),
    },
    {
      id: 'annot.cut',
      label: 'Cut Comment',
      category: 'Comment',
      icon: 'scissors',
      description: 'Copy the selected comments and remove them',
      permission: 'annotate',
      when: annotationSelected,
      run: (ctx) => service(ctx).cutSelection(),
    },
    {
      id: 'annot.paste',
      label: 'Paste Comment',
      category: 'Comment',
      icon: 'clipboard-paste',
      description: 'Paste comments from the clipboard on to this page',
      permission: 'annotate',
      when: open,
      run: (ctx) => service(ctx).paste(),
    },
    {
      id: 'annot.edit',
      label: 'Edit Comment',
      category: 'Comment',
      icon: 'square-pen',
      description: 'Open the selected comment for editing',
      when: annotationSelected,
      run: (ctx) => {
        const s = service(ctx);
        const id = (ctx.args['id'] as ModelId | undefined) ?? s.selection[0];
        if (!id) return false;
        const annotation = s.activeDocument()?.annotation(id);
        if (!annotation) return false;
        if (annotation.family === 'freeText') s.openEditor(id);
        else s.openPopup(id);
        return true;
      },
    },
    {
      id: 'annot.setText',
      label: 'Set Comment Text',
      category: 'Comment',
      hidden: true,
      description: 'Internal: writes a comment’s text without opening its popup',
      when: open,
      run: async (ctx) => {
        const s = service(ctx);
        const id = (ctx.args['id'] as ModelId | undefined) ?? s.selection[0];
        const text = ctx.args['text'];
        if (!id || typeof text !== 'string') return false;
        await s.patch(id, { contents: text });
        return true;
      },
    },
    {
      id: 'annot.setColor',
      label: 'Comment Colour',
      category: 'Comment',
      icon: 'palette',
      description: 'Change the colour of the selected comments',
      permission: 'annotate',
      when: annotationSelected,
      run: async (ctx) => {
        const value = ctx.args['value'];
        const colour =
          typeof value === 'number'
            ? value
            : typeof value === 'string'
              ? Number.parseInt(value.replace('#', ''), 16)
              : Number.NaN;
        if (!Number.isFinite(colour)) return false;
        await service(ctx).patchSelection({ color: colour & 0xffffff }, 'Change colour');
        return true;
      },
    },
    {
      id: 'annot.keepToolSelected',
      label: 'Keep Tool Selected',
      category: 'Comment',
      description: 'Stay in an annotation tool after using it, instead of returning to the hand',
      when: hasService,
      run: async (ctx) => {
        const s = service(ctx);
        const next =
          typeof ctx.args['on'] === 'boolean' ? ctx.args['on'] : !s.settings.keepToolSelected;
        await s.setSetting('keepToolSelected', next);
        return next;
      },
    },
    {
      id: 'annot.identity',
      label: 'Comment Identity…',
      category: 'Comment',
      description: 'The name and initials your comments are signed with',
      when: hasService,
      run: async (ctx) => {
        const s = service(ctx);
        const name = ctx.args['name'];
        if (typeof name === 'string') {
          await s.setIdentity({
            name,
            initials: typeof ctx.args['initials'] === 'string' ? ctx.args['initials'] : '',
            email: typeof ctx.args['email'] === 'string' ? ctx.args['email'] : '',
            asked: true,
          });
          return s.identity;
        }
        await s.setIdentity({ ...s.identity, asked: false });
        return await s.requireIdentity();
      },
    },
    {
      id: 'annot.reply',
      label: 'Reply to Comment',
      category: 'Comment',
      description: 'Add a reply to the selected comment (the thread panel is M32’s)',
      permission: 'annotate',
      when: annotationSelected,
      run: async (ctx) => {
        const s = service(ctx);
        const id = (ctx.args['id'] as ModelId | undefined) ?? s.selection[0];
        const text = ctx.args['text'];
        if (!id) return null;
        const body =
          typeof text === 'string'
            ? text
            : ((await ctx
                .service<{
                  prompt(o: { title: string; label: string }): Promise<string | null>;
                }>(SERVICE.dialogs)
                .prompt({ title: 'Reply', label: 'Your reply' })) ?? null);
        if (body === null || body === '') return null;
        return await s.reply(id, body);
      },
    },
    {
      id: 'annot.setStatus',
      label: 'Set Comment Status',
      category: 'Comment',
      description: 'Mark the selected comment Accepted, Rejected, Cancelled or Completed',
      permission: 'annotate',
      when: annotationSelected,
      run: async (ctx) => {
        const s = service(ctx);
        const id = (ctx.args['id'] as ModelId | undefined) ?? s.selection[0];
        const state = ctx.args['state'];
        if (!id || typeof state !== 'string') return false;
        await s.setState(
          id,
          state,
          typeof ctx.args['model'] === 'string' ? ctx.args['model'] : 'Review',
        );
        return true;
      },
    },

    // ---- developer probes (the acceptance tests read the app through these) -----------------
    {
      id: 'dev.annotations',
      label: 'Annotations on a page',
      category: 'Developer',
      hidden: true,
      description: 'Internal: the annotation model of a page, as the tests read it',
      when: open,
      run: async (ctx) => {
        const s = service(ctx);
        const document = s.activeDocument();
        if (!document) return null;
        const page = Number(ctx.args['page'] ?? 0);
        const modelPage = document.state.pages[page];
        if (!modelPage) return null;
        await s.ensurePage(document, page);
        return document.annotations(modelPage.id).map((a) => ({
          id: String(a.id),
          subtype: a.subtype,
          family: a.family,
          rect: a.rect,
          color: a.color,
          interiorColor: a.interiorColor,
          opacity: a.opacity,
          borderWidth: a.borderWidth,
          contents: a.contents,
          author: a.author,
          subject: a.subject,
          state: a.state,
          inReplyTo: a.inReplyTo === null ? null : String(a.inReplyTo),
          quadPoints: 'quadPoints' in a ? [...a.quadPoints] : [],
          intent: typeof a.extra['intent'] === 'string' ? a.extra['intent'] : null,
          freeTextIntent: a.family === 'freeText' ? intentOf(a.extra) : null,
          icon: typeof a.extra['icon'] === 'string' ? a.extra['icon'] : null,
          style: a.family === 'freeText' ? styleOf(a.extra) : null,
          callout: Array.isArray(a.extra['callout']) ? a.extra['callout'] : null,
          ours: isOurs(a),
          drawnByOverlay: drawnByOverlay(a, new Set([String(a.id)])),
          extra: a.extra,
        }));
      },
    },
    {
      id: 'dev.annotSelection',
      label: 'Annotation selection',
      category: 'Developer',
      hidden: true,
      description: 'Internal: the ids currently selected, and what the layer would draw',
      when: hasService,
      run: (ctx) => {
        const s = service(ctx);
        const layer = s.layer();
        return {
          ids: s.selection.map(String),
          drawn: (layer?.current ?? []).filter((a) => a.shapes.length > 0).map((a) => a.id),
          total: layer?.current.length ?? 0,
          activeTool: ctx.service<{ get(): { activeTool: string | null } }>('ui').get().activeTool,
          keepToolSelected: s.settings.keepToolSelected,
        };
      },
    },
    {
      id: 'dev.annotAppearance',
      label: 'Generated appearance of an annotation',
      category: 'Developer',
      hidden: true,
      description: 'Internal: the content stream the writer would attach to one annotation',
      when: open,
      run: (ctx) => {
        const s = service(ctx);
        const id = (ctx.args['id'] as ModelId | undefined) ?? s.selection[0];
        const a = id ? s.activeDocument()?.annotation(id) : null;
        if (!a) return null;
        const stream = defaultAppearanceService.generate(
          appearanceInput({
            subtype: a.subtype,
            rect: a.rect,
            color: a.color,
            interiorColor: a.interiorColor,
            opacity: a.opacity,
            borderWidth: a.borderWidth,
            contents: a.contents,
            quadPoints: 'quadPoints' in a ? a.quadPoints : [],
            extra: a.extra,
          }),
        );
        return stream === null
          ? null
          : { content: stream.content, bbox: stream.bbox, fonts: stream.resources.fonts };
      },
    },
    {
      id: 'dev.annotDefaults',
      label: 'Annotation tool defaults',
      category: 'Developer',
      hidden: true,
      description: 'Internal: the stored defaults of one tool',
      when: hasService,
      run: (ctx) => {
        const raw = ctx.args['tool'];
        const tool = (typeof raw === 'string' ? raw : 'highlight') as AnnotationToolId;
        return service(ctx).defaults(tool);
      },
    },
  ],

  /*
   * `Mod+Alt+M` and `Mod+Alt+W`, not the `N` and `T` a first guess reaches for: M01 already binds
   * `Mod+Alt+N` to Night Mode and `Mod+Alt+T` to the next theme, and the Registry's rule is
   * last-binding-wins — so taking either would have quietly stolen a key the operator uses daily.
   */
  shortcuts: [
    { key: 'Mod+Alt+M', command: 'annot.note', scope: 'editor' },
    { key: 'Mod+Alt+W', command: 'annot.typewriter', scope: 'editor' },
  ],

  /*
   * One Comment tab, four groups, in Foxit's own order: the markup that acts on selected text,
   * the things you place on the page, the selection tools, and the properties. Ribbon groups
   * collapse when they do not fit, so each group is kept small — the lesson M13 recorded.
   */
  ribbon: [
    {
      id: 'comment.markup',
      tab: 'comment',
      label: 'Text markup',
      order: 10,
      items: [
        'annot.highlight',
        'annot.underline',
        'annot.squiggly',
        'annot.strikeout',
        'annot.replace',
        'annot.insert',
      ],
      large: ['annot.highlight'],
    },
    {
      id: 'comment.place',
      tab: 'comment',
      label: 'Add',
      order: 20,
      items: [
        { kind: 'toggle', command: 'annot.note', pressed: toolIs(NOTE_TOOL) },
        { kind: 'toggle', command: 'annot.typewriter', pressed: toolIs(TYPEWRITER_TOOL) },
        { kind: 'toggle', command: 'annot.textbox', pressed: toolIs(TEXTBOX_TOOL) },
        { kind: 'toggle', command: 'annot.callout', pressed: toolIs(CALLOUT_TOOL) },
      ],
    },
    {
      id: 'comment.select',
      tab: 'comment',
      label: 'Select',
      order: 30,
      items: [
        {
          kind: 'toggle',
          command: `${SELECT_ANNOTATION_TOOL}.activate`,
          pressed: toolIs(SELECT_ANNOTATION_TOOL),
        },
        'annot.selectAll',
        'annot.delete',
      ],
    },
    {
      id: 'comment.properties',
      tab: 'comment',
      label: 'Properties',
      order: 40,
      items: [
        {
          kind: 'toggle',
          command: 'annot.keepToolSelected',
          pressed: (ctx) => hasService(ctx) && service(ctx).settings.keepToolSelected,
        },
        {
          kind: 'dropdown',
          id: 'comment.status',
          label: 'Status',
          icon: 'circle-check',
          when: annotationSelected,
          menu: [
            { label: 'Accepted', command: 'annot.setStatus', args: { state: 'Accepted' } },
            { label: 'Rejected', command: 'annot.setStatus', args: { state: 'Rejected' } },
            { label: 'Cancelled', command: 'annot.setStatus', args: { state: 'Cancelled' } },
            { label: 'Completed', command: 'annot.setStatus', args: { state: 'Completed' } },
            '-',
            { label: 'None', command: 'annot.setStatus', args: { state: 'None' } },
          ],
        },
        'annot.reply',
        'annot.identity',
      ],
    },
  ],

  contextMenus: [
    {
      id: 'm30.commentMenu',
      region: '.viewer-scroll',
      order: 4,
      items: [
        'annot.highlight',
        'annot.underline',
        'annot.strikeout',
        '-',
        'annot.edit',
        'annot.reply',
        'annot.copy',
        'annot.cut',
        'annot.paste',
        'annot.delete',
      ],
    },
  ],
});

// ---- helpers ---------------------------------------------------------------------------------

function isRect(value: unknown): value is { x0: number; y0: number; x1: number; y1: number } {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return ['x0', 'y0', 'x1', 'y1'].every((k) => typeof r[k] === 'number');
}

function calloutArg(value: unknown): Array<{ x: number; y: number }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: Array<{ x: number; y: number }> = [];
  for (const p of value) {
    if (!p || typeof p !== 'object') continue;
    const q = p as Record<string, unknown>;
    if (typeof q['x'] === 'number' && typeof q['y'] === 'number')
      out.push({ x: q['x'], y: q['y'] });
  }
  return out.length > 0 ? out : undefined;
}
