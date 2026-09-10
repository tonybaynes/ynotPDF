# ADR 0019 — Form-field contracts: designed AcroForms, the widget layer and the form write plan

- **Status:** accepted
- **Date:** 2026-09-10
- **Module:** M60 — Form fill & AcroForm field designer; consumed by M61, M62, M81, M82
- **Extends:** [ADR 0005](0005-engine-contract-additions.md) (engine reads),
  [ADR 0007](0007-document-model-contracts.md) (model), [ADR 0010](0010-writer-and-save-contracts.md)
  (write plan), [ADR 0013](0013-annotation-contracts.md) (annotation dictionary entries)

## Context

M60 has to do two things the contracts as they stand cannot express.

1. **Read a form's design, not just its values.** `PdfEngine.formFields()` returns a name, a
   type, a value, two flags and the widget rectangles. A properties dialog needs `/Ff` in full,
   `/DA`, `/Q`, `/MaxLen`, `/Opt` with separate export values, `/TI`, `/AA`, and per widget the
   whole of `/MK` (`/BC`, `/BG`, `/CA`, `/RC`, `/AC`, `/R`, `/TP`, `/I`), `/BS`, `/AS`, `/H` and
   `/F`. PDFium's public API exposes none of the sub-dictionaries: `FPDFAnnot_GetStringValue`
   reads a string entry off the annotation, and `/MK` is a dictionary.
2. **Create a field.** PDFium creates ten annotation subtypes and `Widget` is not one of them
   (ADR 0013 found the same wall for FreeText). There is no API at all for `/AcroForm /Fields`.
   So a designed field cannot exist in the engine, and the writer has to build it.

A third, smaller problem falls out of the second: if the engine cannot hold a designed field, the
engine cannot draw one either, so a designed form and a loaded form would be drawn by two
different things and would not match.

## Decision

### 1. `FormField` grows a `design`, and each widget grows its own appearance

Additive; every existing reader still compiles and every existing field still answers the same
`name`, `type`, `value`, `readOnly`, `required`, `options`, `widgets` and `tooltip`.

```ts
interface FormField {
  // …unchanged…
  /** The whole of the field dictionary a designer edits. Absent from a backend that has none. */
  readonly design?: FieldDesign;
  readonly widgets: ReadonlyArray<{
    readonly page: PageIndex;
    readonly rect: PdfRect;
    /** Index in the page's `/Annots`, so a widget can be found again. */
    readonly index?: number;
    /** `/MK`, `/BS`, `/AS`, `/H`, `/F` for this one appearance. */
    readonly appearance?: WidgetAppearance;
  }>;
}
```

`FieldDesign` and `WidgetAppearance` are declared in **`src/engine/forms/model.ts`** and
re-exported from `PdfEngine.ts`, because the same two shapes are what the appearance generators
take, what the model stores and what the write plan carries — one declaration, four consumers.

`PdfiumEngine` fills them from `rawdoc.ts`, which already exists for exactly this reason: the few
things PDFium's API cannot reach are read from the (decrypted) bytes with pdf-lib's object parser.
`RawInfo` gains `formFields`, keyed by fully-qualified name.

### 2. Three field _roles_ that AcroForm has no `/FT` for

Foxit offers an image field, a date field and a barcode field; ISO 32000 defines none of them.
Each is a standard field wearing a hat, and the hat is recorded so a reopen finds it again:

| Role      | Written as                                                            | Recognised on reopen by                                      |
| --------- | --------------------------------------------------------------------- | ------------------------------------------------------------ |
| `image`   | `/FT /Btn` push button, `/MK /TP 1` (icon only), `/MK /I` the picture | `/YNOTRole /image`, else a captionless icon-only push button |
| `date`    | `/FT /Tx` plus `/AA /F` `AFDate_FormatEx("…")`                        | `/YNOTRole /date`, else the `AFDate_FormatEx` argument       |
| `barcode` | `/FT /Tx` whose `/AP` **is** the barcode                              | `/YNOTRole /barcode` + `/YNOTBarcode << … >>`                |

`/YNOTRole` and `/YNOTBarcode` are private keys in the field dictionary. A second-class name
should carry a registered prefix; `YNOT` is ours and every reader ignores what it does not know,
so a file we write opens correctly everywhere and opens _as a designed form_ here. The barcode's
picture is a real appearance stream, so Acrobat and Chrome show the barcode itself whatever they
make of the private keys — which is the whole point of generating appearances ourselves.

We do not execute JavaScript (`PLAN.md` §1, Parked). `/AA` entries are carried as data — read,
edited by this module's Actions tab, written back — and M61 is what gives them meaning.

### 3. `WritePlan.form` — the whole form, rebuilt

```ts
interface WritePlan {
  // …unchanged…
  /** Non-null only when the session changed a form's *structure* (M60, ADR 0019). */
  readonly form: PlannedForm | null;
}

interface PlannedForm {
  readonly fields: ReadonlyArray<PlannedFormField>;
  /** `/Tabs` per page index; `null` leaves the page's own value alone. */
  readonly tabs: ReadonlyArray<TabOrderMode | null>;
  /** `/AcroForm /DA` and `/Q`, the document-wide defaults. */
  readonly defaultAppearance: string | null;
  readonly quadding: number | null;
}
```

`WritePlan.fields` (ADR 0010) is unchanged and still handles the common case — a reader typed
into a form and saved. `form` is the designer's path, and when it is present the writer

1. detaches every `Widget` annotation from every page and empties `/AcroForm /Fields`;
2. writes the planned fields as a real hierarchy (`/Kids` where a name has dots, radio kids
   sharing one parent), each widget appended to its page's `/Annots` **in plan order** — which is
   what manual tab order means;
3. generates an `/AP /N` for every widget from `src/engine/forms/appearance.ts` and leaves
   `/NeedAppearances` off, so every viewer draws what we drew;
4. keeps `/AcroForm /DR` and merges the fonts our streams used into it.

A rebuild is safe here and nowhere else: the plan is built from `doc.state.fields`, which came
from the engine's read of _every_ field in the file, so nothing that was there is missing from
it. The two exceptions are stated out loud rather than papered over — a signature field whose
`/V` holds a real signature keeps its `/V` object by reference and the save warns that the
signature no longer covers the file (a full rewrite already broke it, ADR 0010), and an XFA form
is opened read-only, so the designer never runs on one.

`WRITE_PHASES` gains `'form'`, between `'objects'` and `'fields'`.

### 4. `WriteIntent` gains `'form'`, and `ModelField` grows the design

`'fields'` still means "a value changed and the engine could not write it". `'form'` means "the
structure changed" and is what turns `WritePlan.form` on. `ModelField.design` and
`ModelWidget.appearance` are **optional** on the model types, so nothing that constructs a field
today has to change; `fieldDesign(field)` fills a default from the field's type where a backend
gave none.

`Document` gains `addFieldRecord`, `updateFieldRecord` and `insertFieldRecord` beside the
`removeFieldRecord` / `putFieldRecord` pair M41 added — the same shape, so an undo puts a field
back exactly where it was.

### 5. The widget layer draws the widgets; the raster stops

`PageLayers.widget` has been reserved since M00. It now holds a **real DOM control per widget** —
`input`, `textarea`, `select`, `button` — positioned over the page, labelled, and styled from the
field's own `/MK` and `/DA` rather than from theme tokens, because a field's colours are content
(the rule M30 set for annotation colours).

While that layer is mounted, the viewer renders the page with `forms: false`, so PDFium does not
draw the widgets as well. `ViewerService` gains `setFormsVisible(visible)` — the same one-line
shape M32 added as `setAnnotationsVisible`. Print, export and every engine-side render keep
`forms: true`; this is a screen flag only.

Three reasons, in order of weight:

1. **A designed field cannot be in the engine at all** (decision 2 above). Drawing loaded fields
   with PDFium and designed ones with the DOM would put two different renderers on one page and
   they would not match.
2. **Typing has to be visible immediately.** Round-tripping every keystroke through the worker to
   get a repainted tile back is not an editor.
3. **Accessibility.** The brief and the operator's rules both want a real labelled control with a
   focus ring, and a real control that is invisible because a bitmap is drawn over it is a lie.

The cost is that our drawing of a loaded field must match what PDFium drew — and it does, because
the same `formAppearance()` that draws the DOM control is what generates the `/AP` the file gets.
A field with no `/MK /BG` is transparent in both, so page content behind the box still shows
through.

## Consequences

- M62 (recognition) produces `FieldDesign` values and reuses the whole write path.
- M61 (validate / format / calculate, import / export, flatten) reads `design.actions` and adds
  meaning to what this module already round-trips.
- M81 and M82 place their appearance in a signature field this module can now create.
- A form written by ynotPDF carries an appearance stream for every widget, which is why it looks
  the same in Chrome's viewer as it does here.
