# src/renderer/view

The page view: coordinate transforms, the per-page layer stack, tiling, and the scrolling
viewport every editing tool will draw on. M00 stubbed the transforms and the layers; M11 built
the rest.

The split is deliberate. Everything that is **maths** is a pure module with no DOM and no engine,
unit-tested in Node; everything that is **DOM** is proved by Playwright in
`test/e2e/viewer.spec.ts`. There is no jsdom in this repo, and pure functions are easier to be
sure of anyway.

## Pure

| File           | What                                                                                    |
| -------------- | --------------------------------------------------------------------------------------- |
| `Viewport.ts`  | `PageTransform` (page space ↔ device pixels) and the zoom constants (M00).              |
| `layout.ts`    | `layoutPages()` — the five layout modes as a table of content-relative page rectangles. |
| `zoom.ts`      | Fit modes, the zoom ladder, zoom buckets, marquee zoom, zoom-about-a-point.             |
| `tiles.ts`     | The tile grid, tile ids and the order tiles are rendered in.                            |
| `TileCache.ts` | An LRU bounded in **bytes**, not entries, that disposes what it evicts.                 |
| `night.ts`     | Night Mode's pixel transform: invert lightness, keep hue.                               |
| `units.ts`     | pt / mm / cm / in, and the ruler's tick spacing at any zoom.                            |
| `guides.ts`    | The guide model, grid lines and snapping.                                               |
| `history.ts`   | Back / forward through view positions (Alt+← / Alt+→).                                  |

## DOM

| File              | What                                                                             |
| ----------------- | -------------------------------------------------------------------------------- |
| `Layers.ts`       | The six overlay layers per page: raster · text · annot · widget · object · tool. |
| `PageView.ts`     | One page: the layer stack, the windowed tile canvas, the tool pointer bridge.    |
| `DocumentView.ts` | The scrolling viewport: virtualised pages, painting, priorities, prefetch.       |
| `TileRenderer.ts` | The only thing that asks the engine for pixels. Owns the cache and the queue.    |
| `Overlays.ts`     | Rulers, grid and guides drawn over the pages.                                    |
| `Loupe.ts`        | The magnifier window.                                                            |
| `PerfHud.ts`      | Frames, tiles and cache, for developer builds and the acceptance test.           |
| `viewer.css`      | All of the above, in theme tokens only.                                          |

## Rules worth keeping

- **Page space is PDF points, origin bottom-left, y up. Device space is CSS pixels, origin
  top-left.** Only `PageTransform` / `PageGeometry` convert between them.
- **Scrolling never renders.** It moves DOM and blits tiles that are already decoded. The engine
  is asked for a tile once per (page, zoom bucket, rotation, render flags, tile).
- **The page canvas is a window on the page, not the page.** At 6400 % a full-page canvas would
  be gigabytes; `PageView` keeps one covering what is visible and moves it.
- **No colour literals.** Layers and overlays take their colours from theme tokens; the page's
  own paper is `--page-paper`, which M01 swaps under Night Mode.
