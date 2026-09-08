/**
 * The find bar (M13) — Foxit's Ctrl+F strip, opaque, over the top-right of the page area.
 *
 * It is deliberately small: a field, a count, previous and next, and a disclosure for the
 * options. Every one of those is also a registered command, so the bar is a convenience rather
 * than the only way in, and the e2e suite drives the commands instead of the pixels.
 */

import { button, el, srOnly } from '@app/dom';
import { icon } from '@app/icons';
import type { FindProgress } from './FindController';
import type { FindOptions } from './search';

export interface FindBarOptions {
  readonly host: HTMLElement;
  readonly options: () => FindOptions;
  readonly onQuery: (query: string) => void;
  readonly onNext: () => void;
  readonly onPrevious: () => void;
  readonly onClose: () => void;
  readonly onToggleOption: (name: keyof FindOptions, value: boolean) => void;
  readonly onOpenPanel: () => void;
}

interface OptionRow {
  readonly name: keyof FindOptions;
  readonly label: string;
  readonly hint?: string;
}

const OPTION_ROWS: ReadonlyArray<OptionRow> = [
  { name: 'matchCase', label: 'Match case' },
  { name: 'wholeWord', label: 'Whole words only' },
  { name: 'regex', label: 'Regular expression' },
  { name: 'ignoreDiacritics', label: 'Ignore accents' },
  { name: 'includeBookmarks', label: 'Include bookmarks' },
  { name: 'includeComments', label: 'Include comments' },
  { name: 'includeFormFields', label: 'Include form values' },
];

export class FindBar {
  readonly element: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly count: HTMLElement;
  private readonly status: HTMLElement;
  private readonly optionsBox: HTMLElement;
  private readonly optionsToggle: HTMLButtonElement;
  private readonly checkboxes = new Map<keyof FindOptions, HTMLInputElement>();
  private readonly options: FindBarOptions;
  private open = false;

  constructor(options: FindBarOptions) {
    this.options = options;
    this.input = el('input.find-input', {
      type: 'search',
      placeholder: 'Find in document',
      'aria-label': 'Find in document',
      autocomplete: 'off',
      spellcheck: false,
    });
    this.count = el('span.find-count', { 'aria-live': 'polite' });
    this.status = el('span.find-status', { role: 'status' });

    const previous = button(
      'icon-btn find-previous',
      { 'aria-label': 'Previous match', title: 'Previous match (Shift+Enter)' },
      icon('chevron-up'),
    );
    const next = button(
      'icon-btn find-next',
      { 'aria-label': 'Next match', title: 'Next match (Enter)' },
      icon('chevron-down'),
    );
    const close = button(
      'icon-btn find-close',
      { 'aria-label': 'Close the find bar', title: 'Close (Escape)' },
      icon('x'),
    );
    const advanced = button(
      'icon-btn find-advanced',
      { 'aria-label': 'Advanced search', title: 'Advanced search' },
      icon('file-search'),
    );
    this.optionsToggle = button(
      'icon-btn find-options-toggle',
      {
        'aria-label': 'Find options',
        title: 'Find options',
        'aria-expanded': 'false',
        'aria-controls': 'find-options',
      },
      icon('sliders-horizontal'),
    );

    this.optionsBox = el('div.find-options', { id: 'find-options', role: 'group' });
    this.optionsBox.hidden = true;
    for (const row of OPTION_ROWS) {
      const box = el('input', { type: 'checkbox' });
      box.addEventListener('change', () => {
        options.onToggleOption(row.name, box.checked);
      });
      this.checkboxes.set(row.name, box);
      const label = el('label.find-option', null, box, el('span', null, row.label));
      this.optionsBox.append(label);
    }

    this.element = el(
      'div.find-bar',
      { role: 'search', 'aria-label': 'Find', id: 'find-bar' },
      el(
        'div.find-row',
        null,
        icon('search'),
        this.input,
        this.count,
        previous,
        next,
        this.optionsToggle,
        advanced,
        close,
      ),
      this.optionsBox,
      this.status,
      srOnly('Press Enter for the next match, Shift+Enter for the previous one.'),
    );
    this.element.hidden = true;
    options.host.append(this.element);

    this.input.addEventListener('input', () => {
      options.onQuery(this.input.value);
    });
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (event.shiftKey) options.onPrevious();
        else options.onNext();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        options.onClose();
      }
    });
    previous.addEventListener('click', () => {
      options.onPrevious();
    });
    next.addEventListener('click', () => {
      options.onNext();
    });
    close.addEventListener('click', () => {
      options.onClose();
    });
    advanced.addEventListener('click', () => {
      options.onOpenPanel();
    });
    this.optionsToggle.addEventListener('click', () => {
      this.toggleOptions();
    });
  }

  get isOpen(): boolean {
    return this.open;
  }

  get query(): string {
    return this.input.value;
  }

  show(query?: string): void {
    this.open = true;
    this.element.hidden = false;
    this.syncOptions();
    if (query !== undefined && query.length > 0) this.input.value = query;
    this.input.focus();
    this.input.select();
  }

  hide(): void {
    this.open = false;
    this.element.hidden = true;
  }

  setQuery(query: string): void {
    this.input.value = query;
  }

  /** Reflects the controller's state: the count, the "searching" note and any bad pattern. */
  setProgress(progress: FindProgress): void {
    const total = progress.hits.length;
    if (progress.error) {
      this.count.textContent = '';
      this.status.textContent = progress.error;
      this.element.dataset['state'] = 'error';
      return;
    }
    if (progress.query.length === 0) {
      this.count.textContent = '';
      this.status.textContent = '';
      delete this.element.dataset['state'];
      return;
    }
    if (total === 0) {
      this.count.textContent = progress.scanning ? 'Searching…' : 'No matches';
      this.status.textContent = progress.scanning
        ? `Searched ${progress.scannedPages} of ${progress.totalPages} pages`
        : '';
      this.element.dataset['state'] = progress.scanning ? 'searching' : 'empty';
      return;
    }
    this.count.textContent = `${progress.current + 1} of ${total}`;
    this.status.textContent = progress.scanning
      ? `Searched ${progress.scannedPages} of ${progress.totalPages} pages`
      : '';
    this.element.dataset['state'] = progress.scanning ? 'searching' : 'found';
  }

  /** Pulls the check boxes back in step with the stored options. */
  syncOptions(): void {
    const options = this.options.options();
    for (const [name, box] of this.checkboxes) box.checked = Boolean(options[name]);
  }

  private toggleOptions(): void {
    const showing = this.optionsBox.hidden;
    this.optionsBox.hidden = !showing;
    this.optionsToggle.setAttribute('aria-expanded', showing ? 'true' : 'false');
  }

  focus(): void {
    this.input.focus();
    this.input.select();
  }

  dispose(): void {
    this.element.remove();
  }
}
