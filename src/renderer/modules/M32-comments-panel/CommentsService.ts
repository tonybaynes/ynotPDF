/**
 * `CommentsService` — the review workflow (M32).
 *
 * It owns three things and deliberately no more:
 *
 * 1. **The panel's view state** — filter, search, grouping, sorting, which groups are collapsed —
 *    which is all preference, never document data.
 * 2. **The review actions** — reply, set a status, tick a checkmark, delete — each of which goes
 *    out as a `Command` through M20's journal, so undo, redo, autosave and M120's batch all work
 *    without this file knowing about any of them.
 * 3. **Comment visibility**, which is a *view* flag: the raster stops drawing annotations and
 *    M30's overlay draws the ones that are still shown (ADR 0017). Nothing is written.
 *
 * It reads the model and never calls the engine, which is the constraint the brief sets and the
 * reason the panel can be rebuilt from a store subscription without a round trip.
 */

import type { ShellServices } from '@app/services';
import type { Registry } from '@core/Registry';
import type { Document } from '@core/Document';
import type { ModelId } from '@core/Ids';
import type { ModelAnnotation } from '@core/model';
import {
  AddAnnotationCommand,
  DEFAULT_ANNOTATION_FLAGS,
  DeleteAnnotationCommand,
  draftAnnotation,
} from '@core/commands';
import type { AnnotationService } from '@modules/M30-markup-annotations/AnnotationService';
import { buildComments, isComment, type CommentEntry } from './model';
import {
  ALL_COMMENTS,
  buildRows,
  isUnfiltered,
  type CommentFilter,
  type GroupBy,
  type RowResult,
  type SortBy,
  type SortDirection,
} from './rows';
import {
  MARKED_MODEL,
  MARKED_OFF,
  MARKED_ON,
  REVIEW_MODEL,
  statusSpec,
  type StatusId,
} from './status';
import {
  DEFAULT_COMMENT_SETTINGS,
  readCommentSettings,
  writeCommentSetting,
  type CommentSettings,
  type SettingsStorage,
} from './settings';

export const COMMENTS_SERVICE = 'comments';
export const COMMENTS_PANEL_ID = 'nav.comments';

/** What is shown on the page. Every field is a view flag; none of it reaches the file. */
export interface VisibilityState {
  /** The master switch. False hides every comment on the page. */
  readonly all: boolean;
  readonly hiddenTypes: ReadonlySet<string>;
  readonly hiddenAuthors: ReadonlySet<string>;
}

export const ALL_VISIBLE: VisibilityState = {
  all: true,
  hiddenTypes: new Set(),
  hiddenAuthors: new Set(),
};

export type CommentsListener = () => void;

interface ViewerLike {
  goToPage(page: number, options?: { readonly record?: boolean }): void;
}

interface ViewerServiceLike {
  readonly active: ViewerLike | null;
  setAnnotationsVisible(visible: boolean): void;
}

interface DocumentServiceLike {
  readonly active: Document | null;
}

export class CommentsService {
  private readonly registry: Registry;
  readonly shell: ShellServices;
  readonly annotations: AnnotationService;
  private readonly storage: SettingsStorage;
  private readonly listeners = new Set<CommentsListener>();
  private readonly disposers: Array<() => void> = [];

  private settingsValue: CommentSettings = DEFAULT_COMMENT_SETTINGS;
  private loaded: Promise<void> | null = null;

  filter: CommentFilter = ALL_COMMENTS;
  search = '';
  collapsed = new Set<string>();
  folded = new Set<ModelId>();
  visibility: VisibilityState = ALL_VISIBLE;

  constructor(options: {
    readonly registry: Registry;
    readonly shell: ShellServices;
    readonly annotations: AnnotationService;
    readonly storage: SettingsStorage;
  }) {
    this.registry = options.registry;
    this.shell = options.shell;
    this.annotations = options.annotations;
    this.storage = options.storage;
    this.disposers.push(
      this.annotations.subscribe(() => {
        this.notify();
      }),
    );
    this.disposers.push(
      this.shell.documents.subscribe(() => {
        // A different document has different comments, and a filter over authors who are not in
        // it would silently hide everything. The view state is per-document.
        this.filter = ALL_COMMENTS;
        this.search = '';
        this.collapsed = new Set();
        this.folded = new Set();
        this.visibility = ALL_VISIBLE;
        this.applyVisibility();
        this.notify();
      }),
    );
  }

  // ---- settings ---------------------------------------------------------------------------------

  get settings(): CommentSettings {
    return this.settingsValue;
  }

  /** Reads the stored preferences. Every write waits for this, so a first-read cannot undo one. */
  async load(): Promise<void> {
    this.loaded ??= (async () => {
      this.settingsValue = await readCommentSettings(this.storage);
    })();
    await this.loaded;
    this.notify();
  }

  async setSetting<K extends keyof CommentSettings>(
    name: K,
    value: CommentSettings[K],
  ): Promise<void> {
    await this.load();
    this.settingsValue = { ...this.settingsValue, [name]: value };
    await writeCommentSetting(this.storage, name, value);
    this.notify();
  }

  // ---- observation ------------------------------------------------------------------------------

  subscribe(listener: CommentsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  // ---- the document -----------------------------------------------------------------------------

  activeDocument(): Document | null {
    return this.documentService()?.active ?? null;
  }

  private documentService(): DocumentServiceLike | null {
    return this.registry.hasService('document')
      ? this.registry.service<DocumentServiceLike>('document')
      : null;
  }

  private viewerService(): ViewerServiceLike | null {
    return this.registry.hasService('viewer')
      ? this.registry.service<ViewerServiceLike>('viewer')
      : null;
  }

  /** Reads every page's annotations, so the panel lists a document rather than what is on screen. */
  async loadAll(): Promise<void> {
    const document = this.activeDocument();
    if (!document) return;
    for (const page of document.state.pages) {
      if (page.id in document.state.annotations) continue;
      await document.loadAnnotations(page.id);
    }
    this.notify();
  }

  /** The comment threads of the active document, in page order. */
  comments(): CommentEntry[] {
    const document = this.activeDocument();
    if (!document) return [];
    const all: ModelAnnotation[] = [];
    for (const page of document.state.pages) all.push(...document.annotations(page.id));
    const index = new Map(document.state.pages.map((page, at) => [page.id, at]));
    return buildComments(all, (pageId) => index.get(pageId) ?? 0);
  }

  /** The flat row list the panel draws. */
  rows(): RowResult {
    return buildRows(this.comments(), {
      filter: this.filter,
      search: this.search,
      group: this.settingsValue.group,
      sort: this.settingsValue.sort,
      direction: this.settingsValue.direction,
      collapsed: this.collapsed,
      folded: this.settingsValue.showReplies
        ? this.folded
        : new Set(this.comments().map((c) => c.id)),
    });
  }

  /** How many comments a filter is currently hiding, for the badge's second number. */
  get filtering(): boolean {
    return !isUnfiltered(this.filter) || this.search.trim() !== '';
  }

  // ---- view state -------------------------------------------------------------------------------

  setFilter(filter: CommentFilter): void {
    this.filter = filter;
    this.notify();
  }

  setSearch(text: string): void {
    this.search = text;
    this.notify();
  }

  async setGrouping(group: GroupBy): Promise<void> {
    await this.setSetting('group', group);
  }

  async setSort(
    sort: SortBy,
    direction: SortDirection = this.settingsValue.direction,
  ): Promise<void> {
    await this.setSetting('sort', sort);
    await this.setSetting('direction', direction);
  }

  toggleGroup(key: string): void {
    if (this.collapsed.has(key)) this.collapsed.delete(key);
    else this.collapsed.add(key);
    this.notify();
  }

  toggleFold(id: ModelId): void {
    if (this.folded.has(id)) this.folded.delete(id);
    else this.folded.add(id);
    this.notify();
  }

  expandAll(): void {
    this.collapsed.clear();
    this.folded.clear();
    this.notify();
  }

  collapseAll(): void {
    const { rows } = this.rows();
    for (const row of rows) {
      if (row.kind === 'group') this.collapsed.add(row.id);
      if (row.kind === 'comment') this.folded.add(row.id);
    }
    this.notify();
  }

  // ---- visibility (a view flag, never the file) --------------------------------------------------

  setVisibility(patch: Partial<VisibilityState>): void {
    this.visibility = { ...this.visibility, ...patch };
    this.applyVisibility();
    this.notify();
  }

  showAll(): void {
    this.setVisibility(ALL_VISIBLE);
  }

  hideAll(): void {
    this.setVisibility({ all: false });
  }

  toggleType(type: string): void {
    const hidden = new Set(this.visibility.hiddenTypes);
    if (hidden.has(type)) hidden.delete(type);
    else hidden.add(type);
    this.setVisibility({ hiddenTypes: hidden, all: true });
  }

  toggleAuthor(author: string): void {
    const hidden = new Set(this.visibility.hiddenAuthors);
    if (hidden.has(author)) hidden.delete(author);
    else hidden.add(author);
    this.setVisibility({ hiddenAuthors: hidden, all: true });
  }

  /** Whether every comment is shown, which is the state that costs nothing to be in. */
  get everythingVisible(): boolean {
    return (
      this.visibility.all &&
      this.visibility.hiddenTypes.size === 0 &&
      this.visibility.hiddenAuthors.size === 0
    );
  }

  /** True when a given comment is drawn on the page. */
  visible(a: ModelAnnotation): boolean {
    if (!this.visibility.all) return false;
    if (!isComment(a)) return true;
    const entry = this.entryFor(a.id);
    const type = entry?.type ?? '';
    const author = entry?.author ?? 'Unknown author';
    if (this.visibility.hiddenTypes.has(type)) return false;
    if (this.visibility.hiddenAuthors.has(author)) return false;
    return true;
  }

  private applyVisibility(): void {
    const viewer = this.viewerService();
    if (this.everythingVisible) {
      this.annotations.setVisibility(null);
      viewer?.setAnnotationsVisible(true);
      return;
    }
    // Hiding anything means the raster can no longer be trusted to draw the right set, so it
    // draws none and M30's overlay draws what is left (ADR 0017).
    viewer?.setAnnotationsVisible(false);
    this.annotations.setVisibility((a) => this.visible(a));
  }

  /** The thread entry for an annotation id, comment or reply. */
  entryFor(id: ModelId): CommentEntry | null {
    for (const entry of this.comments()) {
      if (entry.id === id) return entry;
      const reply = entry.replies.find((r) => r.id === id);
      if (reply) return reply;
    }
    return null;
  }

  /** The thread an id belongs to, whether the id names the comment or one of its replies. */
  threadOf(id: ModelId): CommentEntry | null {
    for (const entry of this.comments()) {
      if (entry.id === id || entry.replies.some((r) => r.id === id)) return entry;
    }
    return null;
  }

  // ---- selection and navigation ------------------------------------------------------------------

  /** Selects a comment and, unless told not to, brings its page into view. */
  select(id: ModelId, options: { readonly jump?: boolean } = {}): void {
    const document = this.activeDocument();
    const annotation = document?.annotation(id);
    if (!document || !annotation) return;
    this.annotations.select([id]);
    const jump = options.jump ?? this.settingsValue.jumpOnSelect;
    if (!jump) return;
    const page = document.pageIndex(annotation.pageId);
    if (page >= 0) this.viewerService()?.active?.goToPage(page);
    this.notify();
  }

  // ---- review actions (every one of them a Command) ----------------------------------------------

  /**
   * Makes sure an annotation has an `/NM`, because that is what a reply's `/IRT` is resolved
   * against when the file is written (ADR 0017). Annotations this app creates do not have one
   * until something needs to point at them, and this is that moment.
   */
  private async ensureName(document: Document, id: ModelId): Promise<void> {
    const annotation = document.annotation(id);
    if (!annotation || (annotation.name !== null && annotation.name !== '')) return;
    await this.annotations.patch(id, { name: newName() });
  }

  /** Adds a reply to a comment. Returns the reply's id, or null when it could not be made. */
  async reply(id: ModelId, text: string): Promise<ModelId | null> {
    const document = this.activeDocument();
    const target = document?.annotation(id);
    if (!document || !target || text.trim() === '') return null;
    let replyId: ModelId | null = null;
    await document.batch('Reply to comment', async () => {
      await this.ensureName(document, id);
      replyId = await this.createReply(document, id, { text: text.trim() });
    });
    this.notify();
    return replyId;
  }

  /**
   * Sets a comment's review status.
   *
   * A status is a *reply* carrying `/State` and `/StateModel` (ISO 32000-1 12.5.6.4), not a field
   * on the comment: that is how the file records who decided what and when, and it is what
   * Acrobat and Foxit both write. Setting the same status twice does nothing rather than adding a
   * second identical entry to the history.
   */
  async setStatus(id: ModelId, status: StatusId): Promise<ModelId | null> {
    const document = this.activeDocument();
    const thread = this.threadOf(id);
    if (!document || !thread) return null;
    if (thread.status === status) return null;
    let replyId: ModelId | null = null;
    await document.batch(`Set status to ${statusSpec(status).label}`, async () => {
      await this.ensureName(document, thread.id);
      replyId = await this.createReply(document, thread.id, {
        state: statusSpec(status).state,
        stateModel: REVIEW_MODEL,
      });
    });
    this.notify();
    return replyId;
  }

  /** Ticks or clears the reader's checkmark — the `/Marked` state model, not a review decision. */
  async toggleCheck(id: ModelId): Promise<void> {
    const document = this.activeDocument();
    const thread = this.threadOf(id);
    if (!document || !thread) return;
    await document.batch(thread.checked ? 'Clear checkmark' : 'Set checkmark', async () => {
      await this.ensureName(document, thread.id);
      await this.createReply(document, thread.id, {
        state: thread.checked ? MARKED_OFF : MARKED_ON,
        stateModel: MARKED_MODEL,
      });
    });
    this.notify();
  }

  /**
   * A reply, a status change or a checkmark: all three are the same annotation in the file — a
   * hidden `Text` with `/IRT`, `/RT /R` and whatever of `/Contents`, `/State` and `/StateModel`
   * the caller has. Hidden because it belongs to the panel and the popup, not to the page.
   */
  private async createReply(
    document: Document,
    parentId: ModelId,
    what: { readonly text?: string; readonly state?: string; readonly stateModel?: string },
  ): Promise<ModelId | null> {
    const parent = document.annotation(parentId);
    if (!parent) return null;
    const identity = await this.annotations.requireIdentity();
    const now = new Date().toISOString();
    const extra: Record<string, unknown> = { icon: 'Comment', replyType: 'R' };
    if (what.stateModel !== undefined) extra['stateModel'] = what.stateModel;
    const draft = draftAnnotation(document, parent.pageId, {
      subtype: 'Text',
      rect: parent.rect,
      flags: { ...DEFAULT_ANNOTATION_FLAGS, hidden: true, print: false },
      contents: what.text ?? '',
      author: identity.name === '' ? null : identity.name,
      created: now,
      modified: now,
      subject: parent.subject ?? undefined,
      name: newName(),
      ...(what.state === undefined ? {} : { state: what.state }),
      extra,
    } as never);
    const withParent = { ...draft, inReplyTo: parentId } as ModelAnnotation;
    await document.apply(new AddAnnotationCommand(document, withParent));
    this.annotations.markEdited(withParent.id);
    // The parent is written in full at save time only when it was touched this session; a new
    // reply changes what the parent means, so it is marked too.
    this.annotations.markEdited(parentId);
    return withParent.id;
  }

  /** Edits the text of a comment or a reply. */
  async setText(id: ModelId, text: string): Promise<void> {
    await this.annotations.patch(id, {
      contents: text,
      modified: new Date().toISOString(),
    });
    this.notify();
  }

  /** Deletes a comment and, when it is a whole thread, every reply under it — as one undo step. */
  async delete(id: ModelId): Promise<number> {
    const document = this.activeDocument();
    if (!document) return 0;
    const thread = this.comments().find((c) => c.id === id);
    const ids = thread ? [...thread.replies.map((r) => r.id), thread.id] : [id];
    await document.batch(
      ids.length > 1 ? 'Delete comment and its replies' : 'Delete comment',
      async () => {
        for (const target of ids) {
          if (document.annotation(target)) {
            await document.apply(new DeleteAnnotationCommand(document, target));
          }
        }
      },
    );
    this.notify();
    return ids.length;
  }

  /** Deletes every comment the current filter keeps — "Delete all comments" with a filter on. */
  async deleteShown(): Promise<number> {
    const document = this.activeDocument();
    if (!document) return 0;
    const { rows } = this.rows();
    const threads = rows.filter((row) => row.kind === 'comment').map((row) => row.entry);
    const ids = threads.flatMap((entry) => [...entry.replies.map((r) => r.id), entry.id]);
    if (ids.length === 0) return 0;
    await document.batch('Delete comments', async () => {
      for (const target of ids) {
        if (document.annotation(target)) {
          await document.apply(new DeleteAnnotationCommand(document, target));
        }
      }
    });
    this.notify();
    return ids.length;
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    this.listeners.clear();
    this.annotations.setVisibility(null);
    this.viewerService()?.setAnnotationsVisible(true);
  }
}

/**
 * A fresh `/NM`. A UUID rather than a counter: `/NM` has to be unique within the page, and a
 * counter would collide the moment two documents' comments met in an import.
 */
export function newName(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ynot-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}
