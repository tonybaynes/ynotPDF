# Keyboard shortcuts

Every shortcut in ynotPDF is a binding to a **registered command**, so anything here can also be
found by name in the command palette (`Ctrl+Shift+P`) and, once M130 lands, rebound in
Preferences. Nothing is reachable only by mouse.

**`Mod`** is `Ctrl` on Windows and Linux, `⌘` on macOS. `Alt` is `⌥` on macOS.

Shortcuts are _editor_-scoped by default: they do nothing while the caret is in a text field or a
modal dialog is open, so typing "z" into the page number does not switch tools. The few that stay
live everywhere are marked **global**.

Started by M11 (viewer); each later module adds its own rows.

## Files and windows

| Keys                               | Command                | What it does                       |
| ---------------------------------- | ---------------------- | ---------------------------------- |
| `Mod+O`                            | `file.open`            | Open a PDF                         |
| `Mod+W`                            | `file.close`           | Close the current document         |
| `Mod+Shift+W`                      | `app.tabs.closeOthers` | Close every other tab              |
| `Mod+Shift+N`                      | `app.window.new`       | New window                         |
| `Mod+Tab` / `Ctrl+Tab`             | `app.tabs.next`        | Next document tab (**global**)     |
| `Mod+Shift+Tab` / `Ctrl+Shift+Tab` | `app.tabs.previous`    | Previous document tab (**global**) |
| `Mod+Q`                            | `app.quit`             | Quit                               |
| `F12`                              | `app.devTools`         | Developer tools                    |

## Editing

| Keys                   | Command           | What it does                               |
| ---------------------- | ----------------- | ------------------------------------------ |
| `Mod+Z`                | `edit.undo`       | Undo (the button says what it will revert) |
| `Mod+Y`, `Mod+Shift+Z` | `edit.redo`       | Redo                                       |
| `Escape`               | `tool.deactivate` | Put the current tool away                  |

## Moving around the document

| Keys                 | Command                  | What it does                                                 |
| -------------------- | ------------------------ | ------------------------------------------------------------ |
| `Mod+G`              | `view.page.goTo`         | Go to page…                                                  |
| `Mod+Alt+→`          | `view.page.next`         | Next page                                                    |
| `Mod+Alt+←`          | `view.page.previous`     | Previous page                                                |
| `Mod+Home`           | `view.page.first`        | First page                                                   |
| `Mod+End`            | `view.page.last`         | Last page                                                    |
| `Page Down`, `Space` | —                        | Down one screen; past the end of a page it steps to the next |
| `Page Up`            | —                        | Up one screen                                                |
| `Alt+←`              | `view.history.back`      | Back to where you were before the last jump                  |
| `Alt+→`              | `view.history.forward`   | Forward again                                                |
| `Mod+Shift+H`        | `view.autoScroll.toggle` | Auto-scroll; press again to stop                             |

`Page Down` / `Page Up` / `Space` act on the page area, so they scroll whichever half of a split
view has the focus.

## Zoom

| Keys               | Command                | What it does           |
| ------------------ | ---------------------- | ---------------------- |
| `Mod+=`, `Mod++`   | `view.zoom.in`         | Zoom in one step       |
| `Mod+-`            | `view.zoom.out`        | Zoom out one step      |
| `Mod+0`            | `view.zoom.actual`     | Actual size (100 %)    |
| `Mod+1`            | `view.zoom.fitPage`    | Fit page               |
| `Mod+2`            | `view.zoom.fitWidth`   | Fit width              |
| `Mod+3`            | `view.zoom.fitVisible` | Fit visible            |
| `Mod`+wheel, pinch | —                      | Zoom about the pointer |

The zoom range is 1 %–6400 %. Zooming with the wheel or the marquee keeps the point under the
pointer where it is, as long as there is room to scroll; when the whole document already fits the
window it simply re-centres.

## The view

| Keys          | Command                     | What it does                                           |
| ------------- | --------------------------- | ------------------------------------------------------ |
| `Mod+Shift++` | `view.rotate.clockwise`     | Turn the view 90° clockwise (the file is not changed)  |
| `Mod+Shift+-` | `view.rotate.anticlockwise` | Turn the view 90° anticlockwise                        |
| `Mod+R`       | `view.rulers.toggle`        | Rulers — drag from one to make a guide                 |
| `Mod+U`       | `view.grid.toggle`          | Grid                                                   |
| `Mod+Alt+N`   | `view.nightMode.toggle`     | Night Mode: darken the page as well as the interface   |
| `F11`         | `view.fullScreen.toggle`    | Full screen; `Escape` leaves                           |
| `Mod+H`       | `view.readingMode.toggle`   | Reading mode: hide the toolbars, keep a small page bar |

Layout, split view, the loupe, line weights and the rendering options have no default key; they
are on the **View** ribbon tab and in the palette. `view.layout.single`, `view.layout.continuous`,
`view.layout.facing`, `view.layout.facingContinuous` and `view.layout.book` are the five layouts.

## Tools

| Keys | Command                     | What it does                                         |
| ---- | --------------------------- | ---------------------------------------------------- |
| `G`  | `tool.hand.activate`        | Hand — drag the page                                 |
| `V`  | `tool.selectText.activate`  | Select text                                          |
| `Z`  | `tool.marqueeZoom.activate` | Marquee zoom — drag a rectangle, or click to zoom in |

While the **loupe** is open, its own window takes the arrow keys (move it), `+` (2× → 4× → 8×)
and `Escape` (close). A **guide** takes `Delete` or `Backspace` when focused.

## Interface

| Keys                      | Command                  | What it does                                                  |
| ------------------------- | ------------------------ | ------------------------------------------------------------- |
| `Mod+Shift+P`             | `app.commandPalette`     | Command palette — every command, searchable                   |
| `Alt` (tap)               | `app.keyTips`            | Show the ribbon key tips                                      |
| `F6`, `Shift+F6`          | `app.focus.next`         | Cycle ribbon → document → left pane → right pane → status bar |
| `F4`                      | `view.pane.left.toggle`  | Left navigation pane                                          |
| `Mod+F4`                  | `view.pane.right.toggle` | Right properties pane                                         |
| `Mod+F1`                  | `app.ribbon.minimise`    | Minimise the ribbon                                           |
| `Mod+Alt+T`               | `theme.next`             | Next theme                                                    |
| `Mod+Alt+Shift+T`         | `theme.previous`         | Previous theme                                                |
| `Mod+Alt++` / `Mod+Alt+-` | `theme.scale.*`          | UI scale up / down                                            |
| `Mod+Alt+0`               | `theme.scale.reset`      | UI scale back to 100 %                                        |

## Developer builds

| Keys        | Command         | What it does                                                |
| ----------- | --------------- | ----------------------------------------------------------- |
| `Mod+Alt+P` | `dev.viewerHud` | Performance HUD: frames per second, tiles per second, cache |

## Conflicts

The shortcut manager takes the last binding registered for a key and, in development builds,
warns with both command ids. `ShortcutManager.conflicts()` lists them; M130's shortcut editor
reads that list.
