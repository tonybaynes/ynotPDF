# src/renderer/view

Page presentation: coordinate transforms, the per-page layer stack and page views.

| File          | What                                                                             |
| ------------- | -------------------------------------------------------------------------------- |
| `Viewport.ts` | `PageTransform` (page space ↔ device pixels), zoom steps, layout modes.          |
| `Layers.ts`   | The six overlay layers per page: raster · text · annot · widget · object · tool. |
| `PageView.ts` | One page's DOM + transform. M11 adds tile rendering on top.                      |

Page space is PDF points, origin bottom-left, y up. Device space is CSS pixels, origin
top-left. Never put colour literals here; layers inherit theme tokens.
