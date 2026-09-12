# ADR 0025: Native file authority belongs to each window

Status: design accepted for audit remediation; implementation in progress.
Date: 12 September 2026. Covers audit findings 14, 15, 16 and 18.

Main validates the runtime arguments and sender/main-frame identity of privileged IPC.
Native open/save/folder dialogs, OS file-open events and an explicit Recent selection grant
file or folder capabilities to one BrowserWindow. Listing Recent does not grant authority.
A normal opened PDF permits read and replacement save; a save selection permits writing
that exact target. Folder selections permit the requested read/export operation below the
selected root. Settings reveal grants reveal/read only. Grants disappear on window close.

Both grants and checks use one native realpath resolver, including missing leaf targets
resolved through their existing parent using basename. Handlers use the checked canonical
path. Linked components below extraction roots are rejected, and leaves are exclusively
created. A collision receives a deterministic numbered suffix, never an implicit overwrite.
The returned path is the actual written name. The selected root must already exist.
These checks do not claim to defeat an adversarial local process swapping directories
between filesystem calls; Node does not expose portable directory-handle-relative writes.

Dropped files retain the existing pathless-open behavior and use Save As. They earn no
filesystem grant. A future enhancement that preserves their native path must obtain it in
preload from a genuine File through webUtils, using a private channel outside the public
invoke allowlist. The renderer cannot grant a string path. Tests earn explicit grants in the
test harness through test-only main setup, not production-handler bypasses.

Opening an embedded file externally requires a main-owned ordinary-document extension
allowlist and a native confirmation before shell.openPath. Scripts, executables, shortcuts
and unknown extensions are refused, with extraction offered by the existing UI.
External web navigation accepts parsed HTTP and HTTPS URLs only.

Validation covers two-window isolation, main-frame rejection, malformed arguments, root
paths, native canonical aliases, Recent enumeration/use, settings reveal, dropped files,
recovery, save, folder export, collisions and linked output components. The full Electron
suite must run on Windows, macOS and Linux before merge.
