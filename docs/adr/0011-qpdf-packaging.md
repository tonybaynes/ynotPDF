# ADR 0011 — How qpdf ships: WebAssembly, and which build

- Status: accepted
- Date: 2026-09-08
- Module: M70 (encryption); consumed by M71, M94, M100, M120, M121

## Context

qpdf is the structural half of the engine (PLAN.md §2): encryption and decryption, linearisation,
repair, object-stream optimisation. M70 is the first module to need it, and the M70 brief leaves
the packaging open on purpose — "`@jspawn/qpdf-wasm` in a worker or bundled CLI via IPC — choose
in an ADR; the app ships whichever".

Three things constrain the choice.

1. **Windows on ARM is a first-class target (M03, ADR 0009).** Any native binary needs a
   `win32-arm64` entry in `resources/binaries.json` or an automatic WASM fallback; the arm64
   installer must never ship a feature that silently fails.
2. **No Docker, and the installer is self-contained (PLAN.md §2).** Whatever qpdf we ship has to
   be fetchable or vendorable at build time by plain GitHub Actions runners.
3. **Where it runs.** Encryption belongs at the end of the save pipeline (M21) and decryption
   before PDFium is handed bytes — both of which the renderer drives. The obvious home was
   therefore a renderer Worker; it turned out not to be possible, for reasons below that are
   worth recording because they will catch the next module that reaches for one.

## Decision

### WebAssembly, not a bundled CLI

qpdf ships as WebAssembly, loaded from `node_modules` (and from `app.asar` in a packaged build) by
the main process. No entry is added to `resources/binaries.json` and nothing is fetched at build
time.

The architecture-independence argument the brief makes is real, but it is not the strongest one.
The strongest one is that **qpdf does not publish binaries we could bundle.** qpdf's GitHub
releases carry Windows builds (`msvc64`, `msvc-arm64`, `mingw`) and nothing else: macOS and Linux
users are expected to install from Homebrew or a distro package, neither of which we may do
inside a self-contained installer. Choosing the CLI would therefore mean building qpdf ourselves
for macOS universal and Linux x64 — a C++ toolchain, zlib, OpenSSL or gnutls, and a cross build
for macOS arm64 — on every release. One 1.3 MB `.wasm` file that is byte-identical on all four
targets is not a compromise here; it is the smaller and more honest thing.

The costs are accepted and measured:

- **Speed.** qpdf-wasm encrypts our fixture corpus in well under a second each. Encryption happens
  once per save, after the writer has already run, and in another process — so it cannot block a
  frame however slow it is.
- **Memory.** Emscripten's MEMFS holds the input and the output at once, so a save peaks at
  roughly three times the document size. That is the same order as the writer itself, and it is
  now main's memory rather than the renderer's.
- **Start-up.** The module is instantiated lazily and per run (see below), which costs about
  40 ms. A session that never touches a protected document never loads it at all.

### The build is `@neslinesli93/qpdf-wasm`, not `@jspawn/qpdf-wasm`

The brief names `@jspawn/qpdf-wasm`. It cannot be used:

- It is version 0.0.2, published July 2022, wrapping **qpdf 10.6**. There have been no releases
  since, and qpdf 11 and 12 are where `--encrypt`'s flag form, the R6 fixes and most of the
  encryption hardening live.
- **It does not load on Node 26.** Its 2022 Emscripten shim decides at runtime that a modern Node
  is a browser (it tests for `fetch`), then calls `fetch()` on a `file://` URL, which undici
  rejects with "unknown scheme" and which no `wasmBinary` or `locateFile` option overrides. Both
  our vitest suite and the Electron main process are that environment.

`@neslinesli93/qpdf-wasm` 0.3.0 (June 2025) wraps **qpdf 12.2.0**, is published as a plain
Emscripten module with `locateFile`, `wasmBinary`, `thisProgram`, `callMain` and a real `FS`, and
runs unmodified in Node 26, in Electron and in a Web Worker. The wrapper is ISC; qpdf itself is
Apache-2.0. Both are on the permitted list and `npm run licenses` passes.

The dependency is pinned exactly (`0.3.0`) and wrapped behind `src/engine/security/qpdf.ts`, whose
surface is `run(args, files)` and nothing else, so replacing the build — with a newer one, or with
a CLI if qpdf ever publishes portable binaries — is one file.

### It runs in the **main process**, not in a renderer Worker

This is the part of the decision that was made twice, and the first answer was wrong.

The obvious home was a renderer Worker, beside M21's writer and M10's engine: same pattern, same
lazy load, no IPC. It was built that way. **It does not work**, and the failure is not one an
application can handle.

`@neslinesli93/qpdf-wasm` was compiled with property renaming, which removed the `wasmBinary`
option along with `print`, `printErr` and `thisProgram`. What survives is `locateFile` — so the
module cannot be _handed_ its bytes, only pointed at a URL that it will go and load. In a packaged
Electron renderer the origin is `file://`, and every URL available there fails:

- a `file://` URL to the sibling `.wasm` is refused, which is why M10 inlines PDFium in the first
  place;
- a `data:` URL of 1.9 MB, and a `blob:` URL made from the inlined bytes, are both loaded through
  Chromium's network service — and doing so **destroys the renderer process**: `render-process-gone`
  with `exitCode 143`, the network and GPU utilities dying with it, no exception raised and no
  window left. Serving the bytes from a wrapped `fetch` avoids the network entirely and the
  renderer still dies. The same module, the same bytes and the same blob URL work perfectly in a
  plain Chromium worker, which is what makes this Electron's problem rather than qpdf's.

Main is a Node environment. The module's own default reads `qpdf.wasm` off disk — from
`node_modules` in development and from inside `app.asar` in a packaged build, both of which `fs`
handles — and there is no fetch, no blob, no worker and no content security policy anywhere near
it. `src/main/security.ts` builds one `Security` lazily; the renderer reaches it through the typed
`security:*` channels, exactly as it reaches `file:writeAtomic`.

It is also, on reflection, where the rest of the plan wants it. M120's batch runs and M121's
command line have no window at all, and the files they work over are already main's.

The costs, stated plainly:

- **Bytes cross a process boundary.** A save already sends the whole document to main for
  `file:writeAtomic`; this adds one more crossing of the same bytes, and Electron's structured
  clone of a `Uint8Array` is a memcpy, not a serialisation.
- **Passwords cross it too.** That is a boundary inside one application, not a network hop:
  neither side writes anything down, and the alternative is a feature that cannot exist.
- **The renderer bundle keeps nothing.** The 1.3 MB of WebAssembly, node-forge and the second copy
  of pdf-lib all leave the renderer, which is a straight improvement on the Worker design.

**Each run gets its own module instance.** qpdf is a command-line program: `main` returning means
`exit()`, and calling `callMain` twice on one instance runs a program that has already ended. Node
tolerates it; a Chromium renderer does not survive it at all. So `Qpdf.run` instantiates, uses and
drops — about 40 ms, once or twice per save — exactly as each invocation of a real `qpdf` would be
its own process. Each run also gets a private MEMFS directory that is emptied afterwards, so a
document's bytes never outlive the call that needed them.

When there is no IPC bridge — a unit test in Node — `SecurityClient` runs the identical `Security`
in-process, so what the tests exercise is what ships.

## Consequences

- No new native binary, so `resources/binaries.json` gains nothing and the arm64 rule in ADR 0009
  is satisfied by construction rather than by a fallback that has to be tested separately.
- M71 (redaction), M94 (PDF/A), M100 (optimise, linearise, repair), M120 (batch) and M121 (the
  command line) get qpdf for free through `src/main/security.ts`; they should extend
  `src/engine/security/qpdf.ts` rather than loading their own copy.
- Anything else that needs a large WebAssembly module and cannot be handed its bytes directly
  should go to main for the same reason. M10's PDFium is safe in its Worker precisely because it
  _can_ be handed its bytes.
- qpdf's own limits become ours. The one that matters for M70 is that qpdf has no public-key
  encryption at all — see ADR 0012.
- If qpdf-wasm is ever abandoned the way its predecessor was, the replacement work is bounded:
  one file, one API, and a fixture corpus that already proves the behaviour.
