# test/fixtures

The PDF corpus. **Synthetic or public-domain only** — never a customer file. This is the only
folder where `.pdf` files may be committed (`.gitignore` + pre-commit hook enforce it).

Regenerate with `npm run fixtures` (`scripts/make-fixtures.ts`, deterministic).

| File              | Exercises                                                                        |
| ----------------- | -------------------------------------------------------------------------------- |
| `blank.pdf`       | 1 A4 page, no content                                                            |
| `multipage.pdf`   | 5 pages: A4 ×2, Letter, landscape A4, A4 with `/Rotate 90`; page numbers drawn   |
| `text.pdf`        | Helvetica / Times / Courier at 24, 11, 10, 9 pt; wrapped paragraphs; rotated run |
| `image.pdf`       | Embedded 64×64 RGB PNG drawn twice (scaled, rotated)                             |
| `form.pdf`        | AcroForm: text, checkbox, radio group, dropdown, multiline text, push button     |
| `annotated.pdf`   | Square, Circle, Highlight (QuadPoints), Text note, Ink annotations               |
| `encrypted.pdf`   | RC4 128-bit standard security (R3). User password `ynot`, owner `owner`          |
| `outline.pdf`     | 3 pages, nested bookmarks (chapter → section) with XYZ destinations              |
| `layers.pdf`      | Optional content: `Base` (on) and `Overlay` (off) with BDC/EMC marked content    |
| `attachments.pdf` | Two embedded files (`note.txt`, `people.csv`) in the EmbeddedFiles name tree     |

M10 adds real-world non-confidential files supplied by the operator (PLAN.md §10.5).
