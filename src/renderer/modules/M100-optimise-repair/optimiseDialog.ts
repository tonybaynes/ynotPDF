/**
 * The Optimise dialog (M100).
 *
 * Five tabs and one line of plain English. The line is the point: **"1.4 MB → 620 kB, 56 %
 * smaller"**, computed by actually running the whole pipeline over a copy, not by estimating. A
 * reader deciding whether to send a file by email needs a number they can trust more than they
 * need it instantly, and every option in here changes that number in ways no formula could
 * predict — a document of photographs and a document of text respond to the same preset quite
 * differently.
 *
 * The tabs are Foxit's own division of the problem (public docs: Images, Fonts, Discard Objects,
 * Discard User Data, Clean Up, Audit space usage), gathered into five because "discard objects"
 * and "discard user data" are one question to a reader: what may go?
 *
 * The two things this dialog refuses to do quietly:
 *
 * - **JPEG 2000 and JBIG2 are named and disabled**, with a sentence saying ynotPDF does not write
 *   them, rather than left out. A reader who came looking for them should find out why they are
 *   not there instead of wondering whether they missed a checkbox.
 * - **Nothing is estimated.** Preview runs the real thing. Where that takes a while, it takes a
 *   while, under M40's progress dialog with a Cancel button that works.
 */

import type { DialogHandle, Dialogs } from '@app/dialog/Dialogs';
import { button, el } from '@app/dom';
import { icon } from '@app/icons';
import { makeRoving } from '@app/focus';
import {
  isLossless,
  type ImageClass,
  type ImageCodec,
  type OptimiseOptions,
  type OptimisePreset,
  type OptimiseResult,
  type SpaceAudit,
} from '@engine/optimise';
import { checkbox, numberField, select } from '@modules/M41-merge-split-crop/fields';
import { auditView, formatBytes, savingLine } from './auditView';

type TabId = 'preset' | 'images' | 'fonts' | 'discard' | 'cleanup' | 'audit';

const TABS: ReadonlyArray<{ id: TabId; label: string; icon: string }> = [
  { id: 'preset', label: 'Preset', icon: 'sliders-horizontal' },
  { id: 'images', label: 'Images', icon: 'image' },
  { id: 'fonts', label: 'Fonts', icon: 'type' },
  { id: 'discard', label: 'Discard', icon: 'trash-2' },
  { id: 'cleanup', label: 'Clean up', icon: 'brush-cleaning' },
  { id: 'audit', label: 'Space used', icon: 'chart-pie' },
];

/** Where the optimised document should end up. */
export type OptimiseTarget = 'new-file' | 'replace';

export interface OptimiseChoice {
  readonly options: OptimiseOptions;
  readonly target: OptimiseTarget;
  /** The result the preview produced, so the caller writes exactly what the reader was shown. */
  readonly result: OptimiseResult | null;
  /** The preset the dialog closed on, so it can be remembered. */
  readonly presetId: string;
}

export interface OptimiseDialogOptions {
  readonly dialogs: Dialogs;
  readonly presets: ReadonlyArray<OptimisePreset>;
  readonly presetId: string;
  /** The document's name, for the title bar. */
  readonly name: string;
  /** The size of what is about to be optimised. */
  readonly size: number;
  /** True when the document has a file to write over. */
  readonly hasPath: boolean;
  /** Runs the whole pipeline over a copy and answers with what it produced, or `null` if cancelled. */
  readonly preview: (options: OptimiseOptions) => Promise<OptimiseResult | null>;
  /** Where the file's bytes are now. Computed once, when the Space used tab is first opened. */
  readonly audit: () => Promise<SpaceAudit>;
  /** Saves the current settings as a preset of the reader's own. */
  readonly savePreset?: (name: string, options: OptimiseOptions) => Promise<void>;
}

const CODECS: ReadonlyArray<{ value: ImageCodec; label: string }> = [
  { value: 'keep', label: 'Leave the compression as it is' },
  { value: 'jpeg', label: 'JPEG — smallest, some loss of detail' },
  { value: 'flate', label: 'Flate — lossless, larger' },
];

const CLASS_WORDS: Readonly<Record<ImageClass, { title: string; hint: string }>> = {
  colour: {
    title: 'Colour images',
    hint: 'Photographs and anything else in colour.',
  },
  grey: {
    title: 'Greyscale images',
    hint: 'Black-and-white photographs and grey scans.',
  },
  mono: {
    title: 'Black-and-white images',
    hint: 'One bit per pixel: faxes, line art and most scanned text.',
  },
};

export async function askOptimise(options: OptimiseDialogOptions): Promise<OptimiseChoice | null> {
  const start =
    options.presets.find((p) => p.id === options.presetId) ?? options.presets[0] ?? null;
  if (!start) return null;

  let current: OptimiseOptions = clone(start.options);
  let presetId = start.id;
  let target: OptimiseTarget = 'new-file';
  let preview: OptimiseResult | null = null;
  let handle: DialogHandle | null = null;

  const summary = el('p.opt-summary', { role: 'status' });
  const details = el('ul.opt-changes');
  const warnings = el('div.opt-warnings');
  const panels = new Map<TabId, HTMLElement>();
  let auditPanel: HTMLElement | null = null;

  /** Everything the reader is told about the *current* options, before any preview has run. */
  const describe = (): void => {
    const lossless = isLossless(current);
    summary.textContent = preview
      ? savingLine(preview.before, preview.after)
      : `${formatBytes(options.size)} now. Press “Check the size” to find out what these settings make of it.`;
    details.replaceChildren();
    if (preview) {
      for (const change of preview.changes) {
        const item = el('li');
        item.append(el('span.opt-change-what', null, change.what));
        if (change.saved > 0) {
          item.append(el('span.opt-change-saved', null, `saved ${formatBytes(change.saved)}`));
        }
        details.append(item);
      }
      if (preview.changes.length === 0) {
        details.append(el('li', null, 'Nothing in this document could be made smaller.'));
      }
    }
    warnings.replaceChildren();
    const lines = preview ? preview.warnings : [];
    if (!lossless && lines.length === 0 && !preview) {
      warnings.append(
        note(
          'info',
          'These settings change the pages. Use the Lossless preset if the document has to come out ' +
            'pixel for pixel identical.',
        ),
      );
    }
    for (const line of lines) warnings.append(note('warning', line));
    handle?.setEnabled('ok', true);
  };

  const invalidate = (): void => {
    preview = null;
    presetId = matchPreset(options.presets, current) ?? 'custom';
    describe();
  };

  // ---- the panels ---------------------------------------------------------------------------------

  const buildPreset = (): HTMLElement => {
    const panel = el('div.opt-panel');
    const list = el('div.opt-presets', { role: 'radiogroup', 'aria-label': 'Preset' });
    for (const preset of options.presets) {
      const row = el('label.opt-preset');
      const input = el('input', { type: 'radio', name: 'opt-preset', value: preset.id });
      input.checked = preset.id === presetId;
      input.addEventListener('change', () => {
        if (!input.checked) return;
        current = clone(preset.options);
        presetId = preset.id;
        preview = null;
        rebuild();
        describe();
      });
      const text = el('span.opt-preset-text');
      text.append(el('span.opt-preset-name', null, preset.name));
      text.append(el('span.opt-preset-desc', null, preset.description));
      if (preset.lossless) {
        const badge = el('span.opt-badge');
        badge.append(icon('shield-check'), el('span', null, 'No pixel changes'));
        text.append(badge);
      }
      row.append(input, text);
      list.append(row);
    }
    panel.append(list);

    if (options.savePreset) {
      const save = button('btn opt-save-preset');
      save.append(icon('bookmark-plus'), 'Save these settings as a preset…');
      save.addEventListener('click', () => {
        void (async () => {
          const name = await options.dialogs.prompt({
            title: 'Save preset',
            label: 'Name',
            hint: 'It will appear in this list next time.',
            value: 'My settings',
            validate: (value) => (value.trim() === '' ? 'Give the preset a name.' : null),
          });
          if (name === null) return;
          await options.savePreset?.(name.trim(), current);
          options.dialogs
            .info('Preset saved', `“${name.trim()}” will be in the list next time you optimise.`)
            .catch(() => undefined);
        })();
      });
      panel.append(save);
    }
    return panel;
  };

  const buildImages = (): HTMLElement => {
    const panel = el('div.opt-panel');
    for (const name of ['colour', 'grey', 'mono'] as const) {
      const words = CLASS_WORDS[name];
      const group = el('fieldset.opt-group');
      group.append(el('legend', null, words.title), el('p.field-hint', null, words.hint));

      const dpi = numberField({
        label: 'Reduce to',
        value: current.images[name].targetDpi,
        min: 0,
        max: 1200,
        step: 6,
        hint: 'Pixels per inch at the size the picture is printed. 0 leaves the size alone.',
        onChange: (value) => {
          current = withPolicy(current, name, { targetDpi: Math.max(0, Math.round(value)) });
          invalidate();
        },
      });
      const threshold = numberField({
        label: 'Only when above',
        value: current.images[name].thresholdDpi,
        min: 0,
        max: 2400,
        step: 6,
        hint: 'A picture already close to the target is left alone rather than resampled for nothing.',
        onChange: (value) => {
          current = withPolicy(current, name, { thresholdDpi: Math.max(0, Math.round(value)) });
          invalidate();
        },
      });

      const codecs =
        name === 'mono'
          ? [
              { value: 'keep' as ImageCodec, label: 'Leave the compression as it is' },
              { value: 'ccitt' as ImageCodec, label: 'CCITT Group 4 — lossless, best for scans' },
              { value: 'flate' as ImageCodec, label: 'Flate — lossless, larger' },
            ]
          : CODECS;
      const codec = select<ImageCodec>({
        label: 'Compression',
        value: current.images[name].codec,
        choices: codecs,
        onChange: (value) => {
          current = withPolicy(current, name, { codec: value });
          invalidate();
          quality.element.hidden = value !== 'jpeg';
        },
      });

      const quality = numberField({
        label: 'JPEG quality',
        value: current.images[name].quality,
        min: 1,
        max: 100,
        step: 5,
        hint: '80 is good for reading and printing; below 50 starts to show.',
        onChange: (value) => {
          current = withPolicy(current, name, {
            quality: Math.max(1, Math.min(100, Math.round(value))),
          });
          invalidate();
        },
      });
      quality.element.hidden = current.images[name].codec !== 'jpeg';

      group.append(dpi.element, threshold.element, codec.element, quality.element);
      if (name === 'mono') {
        group.append(
          note(
            'info',
            'JBIG2 would be smaller again for scanned text, and ynotPDF does not write it. ' +
              'Group 4 is the best it can do without a JBIG2 encoder.',
          ),
        );
      }
      if (name === 'colour') {
        group.append(
          note(
            'info',
            'JPEG 2000 is not offered: ynotPDF does not write it, and an image already in JPEG ' +
              '2000 is left exactly as it is rather than converted.',
          ),
        );
      }
      panel.append(group);
    }

    const grow = checkbox({
      label: 'Never let a picture come out bigger than it went in',
      checked: current.images.neverGrow,
      hint: 'Re-compressing can make a small picture larger. With this on, the original is kept.',
      onChange: (checked) => {
        current = { ...current, images: { ...current.images, neverGrow: checked } };
        invalidate();
      },
    });
    panel.append(grow.element);
    return panel;
  };

  const buildFonts = (): HTMLElement => {
    const panel = el('div.opt-panel');
    const subset = checkbox({
      label: 'Cut embedded fonts down to the letters the document uses',
      checked: current.fonts.subset,
      hint:
        'Usually the largest single saving in a document with no photographs in it. The text is ' +
        'unchanged; a font ynotPDF cannot cut safely is left whole and named in the report.',
      onChange: (checked) => {
        current = { ...current, fonts: { ...current.fonts, subset: checked } };
        invalidate();
      },
    });
    const unembed = checkbox({
      label: 'Stop embedding the fonts every reader already has',
      checked: current.fonts.unembedStandard,
      hint:
        'Only Helvetica, Times, Courier, Symbol, Zapf Dingbats and the faces identical to them ' +
        '(Arial, Times New Roman, Courier New). Any other font keeps its copy in the file, ' +
        'because a reader who has not got it would see something else.',
      onChange: (checked) => {
        current = { ...current, fonts: { ...current.fonts, unembedStandard: checked } };
        invalidate();
      },
    });
    panel.append(subset.element, unembed.element);
    panel.append(
      note(
        'info',
        'PostScript-outline fonts (Type 1 and CFF) are left at full size: cutting one down safely ' +
          'needs a different kind of surgery than ynotPDF performs.',
      ),
    );
    return panel;
  };

  const buildDiscard = (): HTMLElement => {
    const panel = el('div.opt-panel');
    const rows: ReadonlyArray<{
      key: keyof OptimiseOptions['discard'];
      label: string;
      hint: string;
      heavy?: boolean;
    }> = [
      {
        key: 'thumbnails',
        label: 'Page thumbnails stored in the file',
        hint: 'Every reader draws its own. Nothing on the page changes.',
      },
      {
        key: 'alternateImages',
        label: 'Alternative versions of images',
        hint: 'A second copy of a picture for another kind of output. Almost nothing reads them.',
      },
      {
        key: 'privateData',
        label: 'Private data left behind by other programs',
        hint: 'Notes an editor kept for itself. No reader shows them.',
      },
      {
        key: 'metadata',
        label: 'Document information and XMP',
        hint: 'The title, author, subject, keywords and dates. The pages are unchanged.',
        heavy: true,
      },
      {
        key: 'bookmarks',
        label: 'Bookmarks',
        hint: 'The navigation tree down the side. The pages are unchanged.',
        heavy: true,
      },
      {
        key: 'links',
        label: 'Links',
        hint: 'Clickable links and cross-references. The words stay; the clicking stops.',
        heavy: true,
      },
      {
        key: 'comments',
        label: 'Comments and markup',
        hint: 'Notes, highlights, stamps and drawings. They are gone from the optimised copy.',
        heavy: true,
      },
      {
        key: 'forms',
        label: 'Form fields',
        hint: 'The fields and anything typed into them. What was drawn on the page stays.',
        heavy: true,
      },
      {
        key: 'embeddedFiles',
        label: 'Attached files',
        hint: 'Files carried inside the PDF. In a PDF Portfolio, that is all of its contents.',
        heavy: true,
      },
      {
        key: 'javascript',
        label: 'JavaScript',
        hint: 'Scripts the document runs. Calculated form fields stop calculating.',
        heavy: true,
      },
    ];
    for (const row of rows) {
      const box = checkbox({
        label: row.label,
        checked: current.discard[row.key],
        hint: row.hint,
        onChange: (checked) => {
          current = { ...current, discard: { ...current.discard, [row.key]: checked } };
          invalidate();
        },
      });
      if (row.heavy) box.element.classList.add('opt-heavy');
      panel.append(box.element);
    }
    panel.append(
      note(
        'warning',
        'Everything below the line changes what the document contains, not just how big it is. ' +
          'The original file is not touched, but the optimised copy will not have it.',
      ),
    );
    return panel;
  };

  const buildCleanup = (): HTMLElement => {
    const panel = el('div.opt-panel');
    const rows: ReadonlyArray<{
      group: 'structure' | 'dedupe';
      key: string;
      label: string;
      hint: string;
    }> = [
      {
        group: 'structure',
        key: 'objectStreams',
        label: 'Pack the small objects together',
        hint: 'Compresses the file’s bookkeeping. Lossless, and usually worth a few per cent.',
      },
      {
        group: 'structure',
        key: 'recompressStreams',
        label: 'Compress the streams again, harder',
        hint: 'Re-deflates what is already compressed at the highest setting. Lossless.',
      },
      {
        group: 'structure',
        key: 'removeUnused',
        label: 'Remove objects nothing points at',
        hint: 'Left-over pictures and fonts from edits. Lossless.',
      },
      {
        group: 'structure',
        key: 'linearise',
        label: 'Optimise for fast web view',
        hint: 'Puts the first page at the front so it appears before the rest has downloaded.',
      },
      {
        group: 'dedupe',
        key: 'images',
        label: 'Merge identical pictures',
        hint: 'The same logo on forty pages becomes one picture used forty times. Lossless.',
      },
      {
        group: 'dedupe',
        key: 'fonts',
        label: 'Merge identical fonts',
        hint: 'Likewise. Lossless.',
      },
      {
        group: 'dedupe',
        key: 'xobjects',
        label: 'Merge identical drawings',
        hint: 'Headers, footers and watermarks repeated on every page. Lossless.',
      },
    ];
    for (const row of rows) {
      const group = current[row.group] as unknown as Record<string, boolean>;
      const box = checkbox({
        label: row.label,
        checked: group[row.key] ?? false,
        hint: row.hint,
        onChange: (checked) => {
          current = {
            ...current,
            [row.group]: { ...current[row.group], [row.key]: checked },
          };
          invalidate();
        },
      });
      panel.append(box.element);
    }
    return panel;
  };

  const buildAudit = (): HTMLElement => {
    const panel = el('div.opt-panel.opt-audit-panel');
    panel.append(el('p.field-hint', null, 'Working out where this file’s bytes are…'));
    void options
      .audit()
      .then((audit) => {
        panel.replaceChildren(auditView(audit));
      })
      .catch(() => {
        panel.replaceChildren(
          note('warning', 'The space used by this document could not be worked out.'),
        );
      });
    return panel;
  };

  const build = (id: TabId): HTMLElement => {
    switch (id) {
      case 'preset':
        return buildPreset();
      case 'images':
        return buildImages();
      case 'fonts':
        return buildFonts();
      case 'discard':
        return buildDiscard();
      case 'cleanup':
        return buildCleanup();
      case 'audit':
        auditPanel ??= buildAudit();
        return auditPanel;
    }
  };

  /** Rebuilds every panel that has been opened, after a preset changed all the values at once. */
  let rebuild = (): void => undefined;

  handle = options.dialogs.open({
    id: 'optimise-dialog',
    title: `Optimise — ${options.name}`,
    width: 760,
    className: 'optimise-dialog',
    content: (body) => {
      const tablist = el('div.opt-tabs', {
        role: 'tablist',
        'aria-label': 'Optimise settings',
      });
      const host = el('div.opt-panels');
      let active: TabId = 'preset';

      const selectTab = (id: TabId): void => {
        active = id;
        for (const tab of TABS) {
          tablist
            .querySelector<HTMLElement>(`[data-tab="${tab.id}"]`)
            ?.setAttribute('aria-selected', tab.id === id ? 'true' : 'false');
          const panel = panels.get(tab.id);
          if (panel) panel.hidden = tab.id !== id;
        }
        if (!panels.has(id)) {
          const panel = build(id);
          panel.id = `optimise-panel-${id}`;
          panel.setAttribute('role', 'tabpanel');
          panel.setAttribute('aria-labelledby', `optimise-tab-${id}`);
          panel.tabIndex = 0;
          panels.set(id, panel);
          host.append(panel);
        }
        const panel = panels.get(id);
        if (panel) panel.hidden = false;
      };

      rebuild = (): void => {
        for (const [id, panel] of panels) {
          if (id === 'audit') continue;
          const fresh = build(id);
          fresh.id = panel.id;
          fresh.setAttribute('role', 'tabpanel');
          fresh.setAttribute('aria-labelledby', `optimise-tab-${id}`);
          fresh.tabIndex = 0;
          fresh.hidden = id !== active;
          panel.replaceWith(fresh);
          panels.set(id, fresh);
        }
      };

      for (const tab of TABS) {
        const control = button('opt-tab', {
          role: 'tab',
          id: `optimise-tab-${tab.id}`,
          'data-tab': tab.id,
          'aria-selected': 'false',
          'aria-controls': `optimise-panel-${tab.id}`,
        });
        control.append(icon(tab.icon), el('span', null, tab.label));
        control.addEventListener('click', () => {
          selectTab(tab.id);
        });
        tablist.append(control);
      }
      const roving = makeRoving(tablist, { selector: '[role="tab"]' });
      tablist.addEventListener('focusin', (e) => {
        const t = e.target;
        if (!(t instanceof HTMLElement)) return;
        const id = t.dataset['tab'] as TabId | undefined;
        if (id && id !== active) selectTab(id);
      });

      // ---- the size line, which is what the reader came for -----------------------------------
      const check = button('btn opt-check');
      check.append(icon('gauge'), 'Check the size');
      check.addEventListener('click', () => {
        void (async () => {
          check.disabled = true;
          try {
            preview = await options.preview(current);
          } finally {
            check.disabled = false;
          }
          describe();
        })();
      });

      const where = select<OptimiseTarget>({
        label: 'Save the optimised copy',
        value: target,
        choices: [
          { value: 'new-file', label: 'As a new file…' },
          ...(options.hasPath
            ? [{ value: 'replace' as OptimiseTarget, label: 'Over the file this came from' }]
            : []),
        ],
        hint: options.hasPath
          ? 'Saving over the original reloads the document, which clears the undo history.'
          : 'This document has not been saved yet, so there is nothing to save over.',
        onChange: (value) => {
          target = value;
        },
      });

      const result = el('div.opt-result');
      result.append(el('div.opt-result-head', null, check, summary), details, warnings);
      body.append(tablist, host, result, where.element);
      selectTab(active);
      roving.refresh();
      describe();
    },
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'ok', label: 'Optimise', primary: true },
    ],
  });

  const answer = await handle.result;
  if (answer !== 'ok') return null;
  return { options: current, target, result: preview, presetId };
}

// ---- odds and ends ---------------------------------------------------------------------------------

/** A worded note with an icon. Never a colour on its own; the icon and the word carry it. */
function note(kind: 'info' | 'warning', text: string): HTMLElement {
  const box = el('p.opt-note', { 'data-kind': kind });
  box.append(icon(kind === 'warning' ? 'triangle-alert' : 'info'));
  box.append(el('span', null, text));
  return box;
}

function withPolicy(
  options: OptimiseOptions,
  name: ImageClass,
  patch: Partial<OptimiseOptions['images'][ImageClass]>,
): OptimiseOptions {
  return {
    ...options,
    images: { ...options.images, [name]: { ...options.images[name], ...patch } },
  };
}

/** The id of the preset these options exactly are, or `null` when the reader has changed them. */
export function matchPreset(
  presets: ReadonlyArray<OptimisePreset>,
  options: OptimiseOptions,
): string | null {
  const wanted = JSON.stringify(options);
  return presets.find((p) => JSON.stringify(p.options) === wanted)?.id ?? null;
}

function clone(options: OptimiseOptions): OptimiseOptions {
  return JSON.parse(JSON.stringify(options)) as OptimiseOptions;
}
