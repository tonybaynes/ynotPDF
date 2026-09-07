# test/fixtures/external

Real-world PDFs from the **pdf.js test suite** (github.com/mozilla/pdf.js, Apache-2.0), used by
the engine corpus test alongside the synthetic files one folder up. They are **not committed**:
`npm run fetch-fixtures` downloads the files listed in `manifest.json` (pinned to one pdf.js
commit, SHA-256 per file) into this folder. Missing files make the corpus test skip those
entries, so working offline is fine; CI fetches them.

Expected facts (page counts, error codes, passwords) live in `../manifest.json` next to the
synthetic entries.
