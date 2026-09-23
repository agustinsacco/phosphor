# Files and editor

The Files pane is a lazy workspace explorer beside Monaco editor tabs. Gitignore
and hidden-file filters, git status dots and filesystem watching are always on.
A 250 ms debounced watcher patches changed directory listings; agent tool results
refresh every loaded listing immediately, and a two-second directory-mtime poll
covers unavailable or missed watcher events. Reopening the pane re-reads its root,
and the toolbar refresh button re-reads the visible lazy tree on demand.
It exists so you can read and fix the thing the agent just touched without
leaving the conversation.

## File management

- **Create:** toolbar buttons create inside the selected folder (or beside a
  selected file), or at the workspace root with nothing selected. Empty-space
  right-click targets the root; row menus target that row's folder.
- **Rename / Delete:** row menu, F2, Delete (Cmd+Backspace also works). Delete
  moves to Trash after confirmation and warns about unsaved edits. Rename keeps
  descendant editor buffers; a successful delete closes their tabs.
- **Copy / Cut / Paste:** context menu or Cmd/Ctrl+C, X, V while the explorer
  has focus. Copying beside the original makes a numbered "copy". Cut moves
  within the active workspace and clears only the entries that actually moved.
- **Multiple entries:** Cmd/Ctrl-click toggles, Shift-click selects a visible
  range, Cmd/Ctrl+A selects visible rows. Copy, cut and drag act on the
  selection. Rename and Delete want exactly one entry.
- **Drop:** drag files or folders from the OS into the tree to copy them in. A
  folder row targets that folder, a file row its parent, empty space the root.
  Internal drags move; Option/Ctrl-drag copies. The destination highlights.
- **Import:** right-click → Import files / Import folders opens a native
  picker.
- **Navigate:** Up/Down and Home/End move focus, Left/Right collapse and
  expand, Enter opens. Reveal and copy-path stay in the menu. Refresh preserves
  a selected entry that still exists and clears the selection when it was removed.

Existing destinations are refused, never merged or replaced. Transfers report
partial failures, and a completed move retargets its open editors at once.
Copying a folder preserves symlinks without following them. Destinations
outside the workspace (symlink escapes included) and self-nesting are refused.
A failed copy can leave a partial destination; the source is never touched.

The system clipboard accepts incoming Finder/Explorer/Linux file lists;
ordinary copied text is never read as a file. Outbound file paste into OS file
managers is not implemented (Phosphor-to-Phosphor copy/cut works). Cross-device
moves fail safely: copy, then delete.

## Editor

Monaco gives you syntax highlighting, its bundled basic language services,
open-file tabs, dirty indicators and Cmd/Ctrl+S. Clean buffers reload on
external change; dirty ones show a conflict bar so an outside edit never
silently eats your work. Clicking a file leaves keyboard focus in the explorer
for file shortcuts; click the editor to type. Open-at-line navigation focuses
the editor.

Binary files and files over 4 MB can be managed but not edited as text. Not
included: a debugger, external language servers, split editors, bulk delete,
transfer undo, previews of Office documents or archives (use Open in default
app or Quick Look).

## Previews

Images, video, audio, PDFs and HTML open in a viewer instead of Monaco. The
extension decides (`shared/file-kinds.ts`); the size cap does not apply, so a
multi-gigabyte video opens and seeks. HTML and SVG keep a Preview/Source
toggle; the preview shows the saved file, and says so while the buffer has
unsaved edits. Every other file that cannot be edited as text gets a card with
**Open in default app**, **Quick Look** (macOS) and **Reveal**.

The viewers load from `phosphor-file://`, which serves only what main granted
by an unguessable token (`electron/fs/file-protocol.ts`): one file for media
and PDFs, or the workspace for an HTML page, so its relative CSS, images and
scripts resolve. Paths are realpath'd and must stay under the grant; `..` and
symlinks out of it get 404. Video streams with Range requests.

A previewed HTML page runs its scripts in `sandbox="allow-scripts"` under a
policy with no network: it can show sibling files but not `fetch` them, and a
page that loads a library from a CDN renders without it — open it externally
for that. Any frame navigating to http(s) or `file:` is cancelled. PDFs use
Chromium's built-in viewer; links in a PDF open in your browser.

**Open in default app** refuses anything the OS would run rather than open —
apps, installers, scripts, shortcuts, and on macOS/Linux any file with an
execute bit — and does not follow symlinks. Reveal it and decide yourself.
