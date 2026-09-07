# src/renderer/theme

**The only place colour literals are allowed.** `tokens.css` documents every semantic token;
each theme file (`graphite.css`, `midnight.css`, `daylight.css`, `high-contrast.css`, M01)
assigns values under `[data-theme="<name>"]`.

Rules (CLAUDE.md): text ≥ 4.5:1, icons/borders ≥ 3:1, never red/green or gold/green alone,
no `rgba()` alpha < 1, no `opacity` < 1, no `backdrop-filter`. `scripts/check-styles.ts`
enforces the literal/opacity rules; M01 adds the contrast test.

M00 ships a placeholder Graphite palette so the shell renders; M01 replaces it.
