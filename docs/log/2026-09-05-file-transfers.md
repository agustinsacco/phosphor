# Safe file-transfer services

Typed IPC now supports importing files/folders, copying and moving individual
entries, plus file clipboard reads/writes. Transfers preserve binary bytes,
copy folders recursively without following symlinks, and refuse existing
destinations, self-nesting and destinations outside the workspace (including
symlink escapes). Moves stay within the workspace; cross-device moves fail
without a copy/delete fallback. Copying beside the source creates a numbered
“copy” name. Errors can leave a partial destination, but never delete the source.

The clipboard uses a pidex-specific format for internal copy/cut. Incoming
Finder plists, Windows DROPFILES and Linux file-URL lists are supported; plain
text paths are not treated as files. Outbound paste into OS file managers is
not yet provided. Native clipboard formats are platform-specific; parser tests
cover all three and macOS plist conversion runs on macOS. Reads probe the bytes
rather than `availableFormats()`: macOS omits readable custom/file formats from
that enumeration, confirmed by the Electron integration test.
