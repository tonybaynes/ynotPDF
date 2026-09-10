/**
 * M60's commands against a real `Document` and the fake engine, and the write plan they produce.
 *
 * The two belong in one file because they are two halves of the same promise: a designer edit is
 * a `Command` (so undo, autosave and the recovery journal work), and the plan is what turns that
 * edit into a file. A change that does one without the other is the bug this catches.
 */

import { describe, expect, it } from 'vitest';
import { deserialiseCommand, serialiseCommand } from '@core/Journal';
import type { Document } from '@core/Document';
import type { ModelId } from '@core/Ids';
import type { ModelField } from '@core/model';
import { fieldDesignOf } from '@core/model';
import {
  CHOICE_FLAGS,
  COMMON_FLAGS,
  defaultFieldDesign,
  defaultWidgetAppearance,
  flagBit,
  partialName,
  type FieldRole,
} from '@engine/forms/model';
import { BARCODE_KEY, ROLE_KEY } from '@engine/pdfium/rawform';
import {
  AddFieldCommand,
  FormValueCommand,
  RemoveFieldCommand,
  UpdateFieldCommand,
  registerFormCodecs,
} from '@modules/M60-forms/commands';
import { plannedFormFor } from '@modules/M60-forms/plan';
import { FORMS_NAMESPACE, widgetsOnPage } from '@modules/M60-forms/model';
import { SetCustomCommand } from '@core/commands';
import { buildWritePlan } from '@modules/M21-save/plan';
import type { FakeDocumentSpec } from '../core/fakeEngine';
import { must, openFake } from '../core/helpers';

registerFormCodecs();

const SPEC: FakeDocumentSpec = { pageCount: 2 };

/** A model field of `role`, ready to add. */
function draft(
  doc: Document,
  name: string,
  role: FieldRole,
  page = 0,
  rect = { x0: 100, y0: 700, x1: 300, y1: 724 },
): ModelField {
  const design = defaultFieldDesign(role);
  const pageId = must(doc.state.pages[page], 'page').id;
  return {
    id: doc.ids.next('field'),
    name,
    partialName: partialName(name),
    parentId: null,
    childIds: [],
    type: role === 'image' ? 'button' : role === 'date' || role === 'barcode' ? 'text' : role,
    value: '',
    defaultValue: null,
    readOnly: false,
    required: false,
    options: design.options,
    tooltip: null,
    widgets: [
      {
        id: doc.ids.next('widget'),
        pageId,
        rect,
        annotationId: null,
        appearance: defaultWidgetAppearance(role),
      },
    ],
    synthetic: false,
    design,
  };
}

const noWarn = (): void => undefined;

describe('M60’s commands', () => {
  it('adds a field, and undo takes it out again', async () => {
    const { doc } = await openFake(SPEC);
    const field = draft(doc, 'name', 'text');
    await doc.apply(new AddFieldCommand(doc, field));
    expect(doc.state.fields.map((f) => f.name)).toEqual(['name']);
    expect(doc.state.writeIntents).toContain('form');
    await doc.undoLast();
    expect(doc.state.fields).toEqual([]);
    await doc.redoLast();
    expect(doc.state.fields.map((f) => f.name)).toEqual(['name']);
  });

  it('deletes a field and puts it back exactly where it was', async () => {
    const { doc } = await openFake(SPEC);
    await doc.apply(new AddFieldCommand(doc, draft(doc, 'first', 'text')));
    await doc.apply(new AddFieldCommand(doc, draft(doc, 'second', 'text')));
    await doc.apply(new AddFieldCommand(doc, draft(doc, 'third', 'text')));
    const second = must(doc.state.fields[1], 'field');
    await doc.apply(new RemoveFieldCommand(doc, second.id));
    expect(doc.state.fields.map((f) => f.name)).toEqual(['first', 'third']);
    await doc.undoLast();
    expect(doc.state.fields.map((f) => f.name)).toEqual(['first', 'second', 'third']);
  });

  it('replaces a field wholesale, and merges a drag into one undo step', async () => {
    const { doc } = await openFake(SPEC);
    const field = draft(doc, 'box', 'text');
    await doc.apply(new AddFieldCommand(doc, field));
    const move = (dx: number): ModelField => {
      const current = must(doc.field(field.id), 'field');
      return {
        ...current,
        widgets: current.widgets.map((w) => ({
          ...w,
          rect: { ...w.rect, x0: w.rect.x0 + dx, x1: w.rect.x1 + dx },
        })),
      };
    };
    await doc.apply(new UpdateFieldCommand(doc, move(10), 'Move field'));
    await doc.apply(new UpdateFieldCommand(doc, move(10), 'Move field'));
    expect(must(doc.field(field.id)?.widgets[0], 'widget').rect.x0).toBe(120);
    // Two frames of one drag are one entry, so one undo puts the field back where it started.
    await doc.undoLast();
    expect(must(doc.field(field.id)?.widgets[0], 'widget').rect.x0).toBe(100);
  });

  it('keeps a rename apart from a move, because the Undo menu says two different things', async () => {
    const { doc } = await openFake(SPEC);
    const field = draft(doc, 'box', 'text');
    await doc.apply(new AddFieldCommand(doc, field));
    const current = () => must(doc.field(field.id), 'field');
    await doc.apply(new UpdateFieldCommand(doc, { ...current(), name: 'renamed' }, 'Rename field'));
    await doc.apply(
      new UpdateFieldCommand(
        doc,
        {
          ...current(),
          widgets: current().widgets.map((w) => ({ ...w, rect: { ...w.rect, x0: 150 } })),
        },
        'Move field',
      ),
    );
    await doc.undoLast();
    expect(current().name).toBe('renamed');
    await doc.undoLast();
    expect(current().name).toBe('box');
  });

  it('sets a designed field’s value without asking the engine, and merges typing', async () => {
    const { doc, engine } = await openFake(SPEC);
    const field = draft(doc, 'name', 'text');
    await doc.apply(new AddFieldCommand(doc, field));
    await doc.apply(new FormValueCommand(doc, field.id, 'A'));
    await doc.apply(new FormValueCommand(doc, field.id, 'Ad'));
    await doc.apply(new FormValueCommand(doc, field.id, 'Ada'));
    expect(doc.field(field.id)?.value).toBe('Ada');
    // The engine never heard of the field, and was never asked to.
    expect(await engine.formFields(doc.handle)).toEqual([]);
    await doc.undoLast();
    expect(doc.field(field.id)?.value).toBe('');
  });

  it('replays through the journal, which is what recovery and batch need', async () => {
    const { doc } = await openFake(SPEC);
    const field = draft(doc, 'name', 'text');
    for (const command of [
      new AddFieldCommand(doc, field),
      new FormValueCommand(doc, field.id, 'Ada'),
    ]) {
      const json = serialiseCommand(command);
      const back = deserialiseCommand(doc, json);
      expect(back).not.toBeNull();
      if (back) await doc.apply(back);
    }
    expect(doc.state.fields.map((f) => [f.name, f.value])).toEqual([['name', 'Ada']]);
  });
});

describe('the write plan', () => {
  it('is null until the session touches a form’s structure', async () => {
    const { doc } = await openFake(SPEC);
    expect(buildWritePlan(doc).plan.form).toBeNull();
    await doc.apply(new AddFieldCommand(doc, draft(doc, 'name', 'text')));
    expect(buildWritePlan(doc).plan.form).not.toBeNull();
  });

  it('plans every field with its widgets, values and generated appearance', async () => {
    const { doc } = await openFake(SPEC);
    const field = draft(doc, 'order.reference', 'text');
    await doc.apply(new AddFieldCommand(doc, field));
    await doc.apply(new FormValueCommand(doc, field.id, 'ABC-1'));
    const form = must(plannedFormFor(doc, noWarn), 'form');
    expect(form.fields).toHaveLength(1);
    const planned = must(form.fields[0], 'field');
    expect(planned.name).toBe('order.reference');
    expect(planned.type).toBe('Tx');
    expect(planned.value).toBe('ABC-1');
    expect(planned.defaultAppearance).toContain('Tf');
    expect(planned.widgets[0]?.appearance?.content).toContain('(ABC-1) Tj');
  });

  it('gives a check box an on and an off appearance, and says which is showing', async () => {
    const { doc } = await openFake(SPEC);
    const field = draft(doc, 'agree', 'checkbox', 0, { x0: 100, y0: 700, x1: 114, y1: 714 });
    await doc.apply(new AddFieldCommand(doc, field));
    await doc.apply(new FormValueCommand(doc, field.id, 'Yes'));
    const form = must(plannedFormFor(doc, noWarn), 'form');
    const widget = must(form.fields[0]?.widgets[0], 'widget');
    expect(widget.on).toBe(true);
    expect(widget.appearance?.content).toContain('Tj');
    expect(widget.offAppearance?.content).not.toContain('Tj');
  });

  it('carries the private entries the three extra roles need, and nothing else', async () => {
    const { doc } = await openFake(SPEC);
    await doc.apply(new AddFieldCommand(doc, draft(doc, 'plain', 'text')));
    await doc.apply(
      new AddFieldCommand(
        doc,
        draft(doc, 'code', 'barcode', 0, { x0: 100, y0: 600, x1: 244, y1: 672 }),
      ),
    );
    const form = must(plannedFormFor(doc, noWarn), 'form');
    const plain = form.fields.find((f) => f.name === 'plain');
    const code = form.fields.find((f) => f.name === 'code');
    expect(plain?.entries).toBeUndefined();
    expect(code?.entries?.[ROLE_KEY]).toEqual({ kind: 'name', value: 'barcode' });
    expect(code?.entries?.[BARCODE_KEY]?.kind).toBe('dict');
  });

  it('writes a date field’s format as the `/AA` pair every reader understands', async () => {
    const { doc } = await openFake(SPEC);
    await doc.apply(new AddFieldCommand(doc, draft(doc, 'when', 'date')));
    const form = must(plannedFormFor(doc, noWarn), 'form');
    const actions = must(form.fields[0], 'field').actions;
    expect(actions.map((a) => a.trigger).sort()).toEqual(['F', 'K']);
    expect(actions[0]?.value).toContain('dd/mm/yyyy');
  });

  it('plans a choice field’s options and its flags', async () => {
    const { doc } = await openFake(SPEC);
    const field = draft(doc, 'size', 'combobox');
    await doc.apply(new AddFieldCommand(doc, field));
    const design = fieldDesignOf(must(doc.field(field.id), 'field'));
    await doc.apply(
      new UpdateFieldCommand(doc, {
        ...must(doc.field(field.id), 'field'),
        design: {
          ...design,
          flags: design.flags | flagBit(CHOICE_FLAGS.sort),
          options: [
            { value: 's', label: 'Small' },
            { value: 'l', label: 'Large' },
          ],
        },
      }),
    );
    const form = must(plannedFormFor(doc, noWarn), 'form');
    const planned = must(form.fields[0], 'field');
    expect(planned.type).toBe('Ch');
    expect(planned.options).toEqual([
      { value: 's', label: 'Small' },
      { value: 'l', label: 'Large' },
    ]);
    expect(planned.flags & flagBit(CHOICE_FLAGS.sort)).toBeTruthy();
  });

  it('numbers each page’s widgets in tab order, page by page', async () => {
    const { doc } = await openFake(SPEC);
    // Drawn bottom-up and out of order; row order should number them top-down.
    await doc.apply(
      new AddFieldCommand(
        doc,
        draft(doc, 'low', 'text', 0, { x0: 100, y0: 600, x1: 300, y1: 624 }),
      ),
    );
    await doc.apply(
      new AddFieldCommand(
        doc,
        draft(doc, 'high', 'text', 0, { x0: 100, y0: 700, x1: 300, y1: 724 }),
      ),
    );
    await doc.apply(
      new AddFieldCommand(
        doc,
        draft(doc, 'other', 'text', 1, { x0: 100, y0: 700, x1: 300, y1: 724 }),
      ),
    );
    const form = must(plannedFormFor(doc, noWarn), 'form');
    const at = (name: string) =>
      must(form.fields.find((f) => f.name === name)?.widgets[0], 'widget');
    expect(at('high').tabIndex).toBe(0);
    expect(at('low').tabIndex).toBe(1);
    // The second page numbers from zero again: tab order is per page, as `/Tabs` is.
    expect(at('other').tabIndex).toBe(0);
    expect(form.tabs).toEqual(['row', 'row']);
  });

  it('follows a manual order when the page has been given one', async () => {
    const { doc } = await openFake(SPEC);
    const page = must(doc.state.pages[0], 'page');
    await doc.apply(
      new AddFieldCommand(
        doc,
        draft(doc, 'low', 'text', 0, { x0: 100, y0: 600, x1: 300, y1: 624 }),
      ),
    );
    await doc.apply(
      new AddFieldCommand(
        doc,
        draft(doc, 'high', 'text', 0, { x0: 100, y0: 700, x1: 300, y1: 724 }),
      ),
    );
    const keys = widgetsOnPage(doc, page.id).map((w) => w.key);
    await doc.apply(
      new SetCustomCommand(doc, FORMS_NAMESPACE, {
        tabModes: { [page.id]: 'manual' },
        tabOrder: { [page.id]: [...keys].reverse() },
      }),
    );
    const form = must(plannedFormFor(doc, noWarn), 'form');
    const at = (name: string) =>
      must(form.fields.find((f) => f.name === name)?.widgets[0], 'widget');
    expect(at('low').tabIndex).toBe(0);
    expect(at('high').tabIndex).toBe(1);
    expect(form.tabs[0]).toBe('manual');
  });

  it('leaves out a field whose page has gone, and says so', async () => {
    const { doc } = await openFake(SPEC);
    await doc.apply(
      new AddFieldCommand(
        doc,
        draft(doc, 'onPageTwo', 'text', 1, { x0: 10, y0: 10, x1: 100, y1: 30 }),
      ),
    );
    const orphan = must(doc.field(must(doc.state.fields[0], 'field').id), 'field');
    doc.updateFieldRecord({
      ...orphan,
      widgets: orphan.widgets.map((w) => ({ ...w, pageId: 'pg-missing' as ModelId })),
    });
    const warnings: string[] = [];
    const form = plannedFormFor(doc, (m) => warnings.push(m));
    expect(form?.fields).toEqual([]);
    expect(warnings.join(' ')).toMatch(/no longer in the document|no widget/);
  });

  it('says nothing at all about a document with no fields', async () => {
    const { doc } = await openFake(SPEC);
    expect(plannedFormFor(doc, noWarn)).toBeNull();
  });

  it('marks a required field’s flag so a reader knows it must be filled in', async () => {
    const { doc } = await openFake(SPEC);
    const field = draft(doc, 'name', 'text');
    await doc.apply(new AddFieldCommand(doc, field));
    const current = must(doc.field(field.id), 'field');
    await doc.apply(
      new UpdateFieldCommand(doc, {
        ...current,
        design: {
          ...fieldDesignOf(current),
          flags: flagBit(COMMON_FLAGS.required),
        },
      }),
    );
    const form = must(plannedFormFor(doc, noWarn), 'form');
    expect(must(form.fields[0], 'field').flags & flagBit(COMMON_FLAGS.required)).toBeTruthy();
  });
});
