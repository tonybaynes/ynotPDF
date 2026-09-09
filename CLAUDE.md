# CLAUDE.md — ynotPDF

Cross-platform PDF editor (Electron + TypeScript, PDFium engine). Target:
Foxit PDF Editor 14 feature parity. Four themes, dark ("Graphite") default.

**Every session:** read `PLAN.md` §0 (progress) and §12 (parallel
protocol). If the operator names a module, open `docs/modules/<Mid>-*.md`
and follow the **"Your task"** section at the top — it is the complete
brief. Otherwise pick the next unchecked module whose dependencies are ☑.

## Non-negotiables
- TypeScript everywhere. No frontend framework — vanilla DOM plus the
  in-house store. Node 26.
- Colours only through theme tokens (`src/renderer/theme/`). Never a literal.
- **Operator accessibility:** colourblind (red and black read the same — no
  red/green or gold/green differentiation), low vision. Text ≥ 4.5:1,
  icons ≥ 3:1, no grey-on-dark text, status = word + icon. Modals/overlays
  fully opaque: no `rgba()` alpha < 1, no `opacity` < 1, no `backdrop-filter`.
- Every document change is an undoable `Command`.
- Data that can change (stamps, font substitutes, presets) lives in
  `resources/` data files, not in code.
- Permissive licences only (MIT/BSD/Apache/ISC). No MuPDF, iText, Ghostscript.
- Never commit real customer PDFs, binaries, or secrets.
- Own branch + worktree per module (`mod/<Mid>-<name>`); write only in your
  module's folders; shared-file edits minimal, additive, and called out.
- Installing build toolchains (Rust, C++, emsdk) is pre-approved — record it
  in `docs/adr/` and `README.md`. **Never Docker**, build or runtime: the
  installer must be self-contained.

## Toolchain
`npm run dev` · `npm test` · `npm run e2e` · `npm run build` · `npm run lint`

**Sample PDFs:** the operator's real-world test files are in `test/fixtures/local/`
(git-ignored — personal data; only its README is committed): three boarding passes and
`Sample Portfolio.pdf`, a Foxit PDF Portfolio containing them. Use them for manual checks;
tests may open them only behind `existsSync` skips. Never commit or quote their contents.
— all defined by M00. Replies to the operator: short, plain — eyesight.

**Foxit is the feature reference, nothing more.** Never copy Foxit's icons, artwork, wording,
help text or documentation — icons are Lucide first, then Tabler/Phosphor (MIT), Fluent, Material/Remix (Apache-2.0), or our
own in the Lucide stroke style — every set used goes in `resources/credits.json`.
Clipart: Openclipart / Public Domain Vectors (CC0), Wikimedia Commons (CC0/PD/CC BY only), unDraw,
Pixabay. Never BY-SA / NC / ND, never Freepik/Flaticon/Vecteezy. Each item goes in credits.json. Generic conventions shared across Adobe/Foxit/Tungsten
(magnifier, hand, highlighter, stamp, padlock) are fine to use; Foxit's specific artwork is not; help is written from scratch. The logo in `resources/brand/` is provisional.
Never open, read, extract or decompile files from an installed Foxit/Adobe/Tungsten product —
learn their behaviour as a user only. Design decisions in each brief record where behaviour
came from (public docs, ISO 32000, our own choice): that is the provenance record.
