# ADR 0019 — Optimise, repair and Fast Web View: the contract additions

- Status: accepted
- Date: 2026-09-10
- Module: M100 (optimise, linearise, repair, remove duplicates); consumed by M94, M120, M121

## Context

M100 has to reduce a file's size, linearise it for fast web view, repair a damaged one and merge
duplicate resources. Three of those need something that does not exist yet, and each of the three
touches a file another module owns. This ADR records what was added and why the shape is additive.

1. **qpdf, from the renderer.** M70 established (ADR 0011) that this build of qpdf-wasm cannot run
   in an Electron renderer — it dies with `render-process-gone` and no exception — so qpdf lives
   in the main process behind the `security:*` channels. M100 needs four more things from it:
   object streams and flate recompression, unreferenced-object removal, linearisation, and
   `--check` / reconstruct for repair.
2. **Repair when a file will not open.** The engine refuses a damaged file with
   `EngineError('corrupt')`, which today surfaces as an error toast. Offering "Repair" at that
   moment is the point of the feature; the decision is where the offer is made from.
3. **Linearising on save.** M21 writes the file, M70 already transforms the writer's output through
   a save-pipeline stage (ADR 0012), and linearisation is exactly that shape of work.

## Decision

### 1. Four additive IPC channels, `optimise:*`

Added to `src/shared/ipc.ts`, handled in `src/main/ipc.ts`, backed by one lazily built
`QpdfTasks` in `src/main/optimise.ts` — the same arrangement, file for file, as M70's
`security:*` and `src/main/security.ts`.

| Channel              | Args                      | Result                                                                   |
| -------------------- | ------------------------- | ------------------------------------------------------------------------ |
| `optimise:structure` | bytes, `StructureOptions` | `{ bytes, warnings }`                                                    |
| `optimise:linearise` | bytes                     | `{ bytes, warnings }`                                                    |
| `optimise:check`     | bytes                     | `QpdfCheck` — `{ ok, linearised, encrypted, version, warnings, errors }` |
| `optimise:repair`    | bytes                     | `{ bytes, warnings, repaired }` — the fallback of 1a                     |

`QpdfTasks` (`src/engine/optimise/qpdf/tasks.ts`) is the façade, shaped like `Security`: a `Qpdf`
in, four methods out, no UI and no model, so a Node test drives the real qpdf directly and M120's
batch will drive it with no window open. Nothing above it mentions argv.

Bytes cross the boundary twice per optimise, which is the crossing a save already makes.

### 1a. Repair is PDFium's, not qpdf's — this build of qpdf cannot reconstruct

The brief assumed `qpdf --check` for detection and a qpdf rewrite for the repair itself. The first
half holds. The second does not, and it is worth writing down because the next module that reaches
for qpdf recovery will assume the same thing.

**`@neslinesli93/qpdf-wasm` 0.3.0 (qpdf 12.2.0) never reconstructs a cross-reference table.**
Measured against five kinds of damage — `startxref` past the end of the file, `startxref 0`, no
`startxref` at all, a corrupted `xref` keyword, and a file truncated at 70 % — every one comes back
as exit code 2, one line of explanation, and no output file. A native qpdf warns "attempting to
reconstruct cross-reference table" and carries on; this one never does. The cause looks structural
rather than a bug: qpdf's recovery paths are all driven by catching its own exceptions, and this
WebAssembly build does not catch them, so the first throw comes straight out of `main`.

**PDFium does reconstruct**, which is what the corpus already recorded (`broken-xref.pdf`: "PDFium
reconstructs"). So the repair is:

1. Ask the engine to open the bytes. PDFium rebuilds the cross-reference table on the way in, and
   saving the document back out writes a file with a correct one. Verified: the repaired
   `broken-xref.pdf` comes back `qpdf --check` clean.
2. If the engine refuses, try a qpdf rewrite — the two disagree about what is fatal, so a file
   PDFium will not open is sometimes one qpdf will.
3. If neither will read it, say so, with what qpdf said about it.

Detection stays `qpdf --check`, and it is still the right tool for it: it reads a file PDFium has
already opened happily and says what is wrong with it, which is exactly what "offer Repair on
`qpdf --check` warnings" in the brief asks for.

### 2. `repair` — one optional service, consulted by `ViewerService`

`src/renderer/modules/M11-viewer/ViewerService.ts` already asks the registry for an optional
`security` service before the engine sees a file's bytes (M70). M100 adds the mirror image of
that on the failure path:

```ts
export interface RepairService {
  /** The engine refused these bytes. Returns repaired bytes to retry with, or null to give up. */
  offerRepair(bytes: Uint8Array, name: string, error: unknown): Promise<Uint8Array | null>;
}
```

`ViewerService.open` catches a non-password open failure and, **only when a `repair` service is
registered**, hands it the bytes and the error; anything it returns is opened in place of the
original. A build without M100 has no such service and behaves exactly as before, which is what
makes this additive rather than a change.

The alternative — M100 wrapping `file.openBytes` — was rejected: commands cannot be wrapped, and
duplicating the open path would mean two implementations of "turn bytes into a tab".

The interface is declared in `src/renderer/modules/M100-optimise-repair/RepairService.ts` and
imported by M11 as a type only, so the dependency is one way and disappears at compile time.

### 3. Fast Web View is a save-pipeline stage at order 50

No contract change: M21's `SavePipelineStage` (ADR 0012) already allows it. Recorded here because
of the ordering constraint it exposes.

M70's stage runs at order 100 and re-protects by running qpdf `--encrypt`, which writes a new file.
**A qpdf rewrite without `--linearize` is not linearised**, so a stage at order 50 has its work
undone whenever the document is also being protected, and a stage at order 150 cannot linearise a
file it has no password for.

The decision is to run at 50 and, when another stage answers `handlesSecurity(documentId)`, to
**skip and warn in words**: "Fast web view was not applied, because this document is being password
protected and the two cannot both be produced in one save." Producing one of the two silently, or
claiming both, would be worse than saying it.

## Consequences

- `src/shared/ipc.ts` grows four channels and three exported result types; `src/main/ipc.ts` grows
  four handlers; `src/main/optimise.ts` is new. All additive.
- `src/renderer/modules/M11-viewer/ViewerService.ts` grows one `try`/`catch` and one optional
  service lookup, and imports one type from M100. Listed in the PR description.
- M94 (PDF/A) gets `optimise:check` for free, and M120/M121 get the whole optimise pipeline as
  pure functions plus four channels, with no window involved.
- `src/engine/optimise/**` may not import from `src/main`, `src/renderer` or `node:*`. The qpdf
  façade takes a `Qpdf` rather than making one, which is what keeps that true.
