# M100 — Optimise, linearise, repair, remove duplicates

Make a PDF smaller without making it wrong; say where its bytes went; rebuild it when it is
damaged. Spec: [`docs/modules/M100-optimise-repair.md`](../../../../docs/modules/M100-optimise-repair.md).
Contracts: [ADR 0019](../../../../docs/adr/0019-optimise-contracts.md).

## Where the work happens

An optimise is split across three processes, and the split is not arbitrary — it is where each
tool can run at all.

| Where               | What                                                                                      | Why there                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Renderer Worker** | Images, fonts, duplicates, discards — everything in `src/engine/optimise/`                | Seconds of solid arithmetic. On the main thread that is a frozen window and a Cancel button nobody can press. |
| **Main process**    | qpdf: object streams, flate recompression, unreferenced objects, linearisation, `--check` | This build of qpdf-wasm kills a renderer outright (ADR 0011). Main is an ordinary Node environment.           |
| **Renderer**        | The dialog, the report, the file the reader ends up with                                  | It is the only one with a window.                                                                             |

`OptimiseClient` is the seam: it posts to the Worker, then makes one IPC call to main, then folds
the two halves into one report with `withStructure` so the reader sees one set of numbers.

## The rule this module is built around

**Optimising produces a file. It never rewrites the open document underneath its model.** The
engine owns bytes, the `Document` owns intent, `Document.handle` is `readonly` and every model
page is bound to an engine index — so swapping optimised bytes under a live model is not
something the contract allows, and faking it would cost the reader their undo history without
saying so. Foxit's Reduce File Size and Advanced Optimization both end in a Save As, so this is
also what the reference does.

That is why **M100 registers no undoable `Command`**: it changes no document. The one thing it
changes about an open one is a setting — whether saves are linearised — which is not a document
change either.

## Files

| File                 | What                                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.ts`        | The five commands, the ribbon group, the backstage slot, and the two `dev.*` probes the e2e suite reads.                                     |
| `OptimiseService.ts` | Registered as `optimise`, and as `repair` for M11's open path. Settings, presets, the pipeline, the check, the repair, and M21's save stage. |
| `OptimiseClient.ts`  | The Worker's other end, plus the qpdf IPC call.                                                                                              |
| `optimise.worker.ts` | The Worker. Pure passes only; no qpdf.                                                                                                       |
| `optimiseDialog.ts`  | Five tabs and one line of plain English: "1.4 MB → 620 kB, 56 % smaller".                                                                    |
| `auditView.ts`       | The space audit's donut and table, and the words and numbers both use.                                                                       |
| `settings.ts`        | The typed reader, the schema M130 renders, and the reader's own presets.                                                                     |
| `optimise.css`       | Tokens only, nothing translucent.                                                                                                            |

## Two things done deliberately differently

**The chart's slices are told apart by hatch pattern, not colour.** The operator is colourblind
and this project forbids differentiating by colour alone, so the donut uses solid / diagonal /
cross / dotted / horizontal / vertical fills in two theme tokens, and the table beside it carries
the same figures in words. A reader who cannot see the chart at all loses nothing.

**Nothing is estimated.** "Check the size" runs the whole pipeline over a copy and reports what it
actually produced, then keeps those bytes so pressing Optimise writes exactly what was promised.
Estimating would be cheaper and would be wrong for exactly the files where the number matters.

## What it will not do

- **JPEG 2000 and JBIG2 encoding** are out of scope (the brief). The dialog names them and says
  why rather than leaving them out, and an image already in either is left strictly alone.
- **PostScript-outline fonts** (Type 1, CFF) keep their full font program: cutting one down safely
  is a different kind of surgery from the TrueType blanking in `sfnt.ts`.
- **Unembedding anything but a standard face.** Only the Standard 14 and the families metrically
  identical to them. A 200 KB saving is not worth a document that is wrong on half the computers
  that open it.
