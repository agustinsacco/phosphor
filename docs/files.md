# Files and editor

Local Files is a lazy workspace explorer beside Monaco editor tabs. Gitignore
and hidden-file filters, git status dots and filesystem watching are always on.
A 250 ms debounced watcher patches changed directory listings; agent tool results
refresh every loaded listing immediately, and a two-second directory-mtime poll
covers unavailable or missed watcher events. Reopening the pane re-reads its root,
and the toolbar refresh button re-reads the visible lazy tree on demand.
It exists so you can read and fix the thing the agent just touched without
leaving the conversation.

Opening a file or switching editor tabs expands its ancestor folders, highlights
its row and scrolls it into view without taking keyboard focus. Only that path
is loaded, and hidden/gitignore filters still apply. Cmd/Ctrl+P opens the Files
pane on the explorer tree, replacing the content-search panel if it was open.
Content search keeps its results visible while stepping through matches; returning
to the explorer reveals the active file. The finder also works from the editor,
accepts `file.ts:line:column`, reports index-loading failures, and restores the
previous keyboard focus on dismissal.

## Remote lanes

A Host lane's Files and Changes are This Mac's panes over the lane's files
source: the same explorer, editor tabs, viewer and Changes list. What a Host
offers is data on that source, not a separate pane. With `workspaces.read`,
Files lists the lane's tracked and untracked non-ignored files, one list per
refresh folded into the tree. A folder made in Files shows at once; one made
elsewhere (by the agent or on the Host) shows once it holds a file, since the
Host lists files. With `workspaces.write` and `sessions.control`, the
controller edits text and saves with Cmd/Ctrl+S or Save all, creates files and
folders, renames, deletes to trash with This Mac's confirm, and moves entries
by dragging them in the tree (Option/Ctrl copies). Without them the explorer shows a
"Read only" tag naming the reason and the editor is read-only. A Host lane hides
what needs a local folder: content search, the hidden-file and .gitignore
toggles, the OS clipboard and file import, Reveal, Quick Look, Open in default
app and media previews.

Saves send the SHA-256 revision the editor read, not an mtime, one at a time per
file; a pane that remounts during a save sees it and sends nothing more. A
conflict keeps the buffer and offers Reload, not Keep mine, which the revision
check would refuse again. An uncertain save keeps the edits under "Save not
confirmed. Your edits are kept. Do not retry an uncertain save." and is never
retried; Reload file reads the file again and discards the edited buffer.
Folders start collapsed and the toolbar's Collapse all folders closes every one,
as on This Mac; a file opened from search or a chat link opens its folders.
Opening another file opens a tab, as on This Mac; one path is one buffer, and
closing a dirty tab asks first. Open files and unsaved edits live in the files
store per lane, survive lane switches and closing the pane, and are dropped when
the lane is forgotten.

A failed git status shows "Git status is unavailable." and does not hide the
file list, and configured non-git folders can be browsed: the Host skips the
hidden, dependency and build folders This Mac's Go to file skips and lists at
most 20,000 files ([Host](host.md#machine-features)). A list that is too big or
that the Host could not read says so ("Too many files to list: the Host stops at
20,000." or "The Host couldn't list this folder."). Changes is This Mac's
agent-touched view: the files the lane's edit and write tools touched, each with
an inline diff read through the Host. Revert needs a session baseline the Host
does not keep yet, so a Host lane hides it. Binary and oversized files use
placeholders; a Host reads text up to 2 MB, and a read the Host could not do is
the error toast "Could not read this file." that opens no tab, as on This Mac.
Markdown, HTML and SVG files open on Preview with Source one click away, in
Desktop and the browser, rendered from the text the Host sent (HTML and
SVG in the artifact sandbox). The pane refreshes on focused lane summary changes,
reconnects, a new Host runtime and its Refresh button, never a local filesystem
watcher. Dirty buffers are not reloaded. During a disconnect the open files stay
on screen, read-only, under "Unsaved edits are kept."; reconnection keeps the edited
text and original revision for conflict checking and never substitutes a fresh
read for unsaved edits.
Chat links, tool path chips and the finder open through an explicit remote lane
and can reveal a line. Host absolute paths must be inside that lane's cwd.
Editor models and caches are lane-qualified. Machine-level Files browses
configured Host repositories read-only without opening a lane. The browser's
Files pane is read-only. Its folders, and Machine-level Files', start collapsed
and open for a selected file; the browser's Files has Collapse all, and its
Changes starts expanded.
[Remote surface gaps](future-features.md#remote-surface-gaps) lists unavailable
operations. Without the capability, the pane shows “This Host does not offer files to this
device.”, and “Machine not connected. Wait for reconnection.” while the Host is away.
See [Remote Desktop](remote-desktop.md#remote-read-panes) for routing and bounds.

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
- **Navigate:** Up/Down and Home/End move focus; Shift extends or shrinks the
  selection. Left collapses an expanded folder, otherwise moves to the parent.
  Right expands a folder, then enters its first child. Typing selects a visible
  filename by prefix without opening it; Enter opens. The toolbar can collapse
  all folders or reveal the active file again. Refresh preserves a selected
  entry that still exists and clears the selection when it was removed.

Existing destinations are refused, never merged or replaced. Transfers report
partial failures, and a completed move retargets its open editors at once.
Copying a folder preserves symlinks without following them. Destinations
outside the workspace (symlink escapes included) and self-nesting are refused.
A failed copy can leave a partial destination; the source is never touched.

The system clipboard accepts incoming Finder/Explorer/Linux file lists;
ordinary copied text is never read as a file. Outbound file paste into OS file
managers is not implemented (Phosphor-to-Phosphor copy/cut works). Cross-device
moves fail safely: copy, then delete.

## Search in files

Cmd/Ctrl+Shift+F, or the magnifier in the explorer toolbar, swaps the explorer
for a search panel (`features/files/WorkspaceSearch.tsx`). A one-line
selection, on the page or in the editor, seeds the query, escaped when Regex is
on. Results arrive as you type, 250 ms after the last
key, grouped by file. Each line keeps its match in view however narrow the
pane: the text after the match gives way first, then the text before it. The
Match case / Whole word / Regex toggles and their ⌥C, ⌥W, ⌥R keys are the same
ones find uses. The ⋯ header toggle shows **Files to include** and **Files to
exclude**: comma-separated globs (`libs/shared/src/glob.ts`). `*.ts` matches at any
depth, a folder name covers everything under it, and a leading `/` anchors a
pattern at the workspace root. Matching ignores case.

- **Open a match:** a click opens the file with the match selected and leaves
  focus in the list, so you can keep stepping. Double-click or Enter moves
  focus into the editor, and Space opens without moving focus. HTML and SVG
  open on their Source view, where the match is.
- **Navigate:** Down from the field enters the list. Up/Down and Home/End move,
  and Left/Right fold a file or move between it and its matches. Esc in the
  list, or Up from its first row, returns to the field; Esc in the field
  returns to the explorer, which takes focus.
- **State:** the query, options, globs and results are per workspace. They
  survive closing the panel or the pane, and the header's refresh re-runs the
  search.

The search runs in main, in a worker thread
(`apps/desktop/electron/fs/workspace-search-service.ts`). Each keystroke's search replaces
the window's last one, and a regex that backtracks without end is terminated
with its worker instead of freezing the app. The query and globs are compiled
once, by the same code in the panel and in main (`libs/shared/src/workspace-search.ts`),
so a bad regex or glob says so as you type. The worker runs the search core in
`libs/session-runtime/src/files/workspace-search.ts`. It reads the files the fuzzy finder
lists: git's tracked and untracked files without the ignored ones, or a bounded
walk outside a repository. It never follows a symlink, to a file or through a
folder out of the workspace. Binary files (a NUL in the first 8 KB), images,
video, audio, PDFs and files over 4 MB are skipped and counted. Lines end where
the editor ends them, at LF, CRLF or a lone CR, so a result's line and column
land on the match. A search stops at 2,000 results, after 20 seconds (the
listing included), or at the 20,000th listed file, and the panel says which
limit it hit and keeps what it found.

## Editor

Monaco gives you syntax highlighting, its bundled basic language services,
open-file tabs, dirty indicators and Cmd/Ctrl+S. Saves to the same path are
serialized and mark only the written revision clean; edits made during a save
remain dirty. Closing a dirty tab asks Save / Don’t Save / Cancel. Save failures
or newer edits keep the tab open; Escape cancels. Failed saves retain the buffer and show an error. A reload that
finishes after typing preserves the newer buffer and reports a conflict.
Clean buffers reload on external change; dirty ones show a conflict bar so an outside edit never
silently eats your work. Clicking a file leaves keyboard focus in the explorer
for file shortcuts; click the editor to type. Open-at-line navigation focuses
the editor; a single click on a search result is the exception. Asking again
for a line already open reveals it again, and switching back to a tab never
jumps it to an old target.

Editor tabs show the shortest distinguishing path when filenames repeat, and
the current file's full relative path stays visible above the editor. Drag tabs
to reorder; their context menu offers Pin, Close others, Close to the right,
Close saved tabs and Reopen closed tab. Bulk closing skips pinned tabs and stops
at Cancel. Tab arrows/Home/End navigate accessibly, Ctrl+Tab cycles (Shift
reverses), Cmd/Ctrl+W safely closes, and Cmd/Ctrl+Shift+T reopens from a bounded,
workspace-local in-memory history. Failed reopen attempts show an error and
leave older history reachable on the next request. Save all is available above
the editor and on Cmd/Ctrl+Alt+S; IME composition and AltGr text remain untouched. These shortcuts apply inside the Files pane, not other panes
or dialogs.

Binary files and files over 4 MB can be managed but not edited as text. Not
included: a debugger, external language servers, split editors, bulk delete,
transfer undo, previews of Office documents or archives (use Open in default
app or Quick Look).

## Reverting session changes

Revert restores only the working copy, leaving staged Git content untouched.
An unavailable baseline or a read error refuses the operation; only confirmed
absence from a valid baseline permits moving a newly created file to Trash.
Unsaved editor buffers must be saved or discarded first. Writes without a Git
baseline cannot be safely reverted automatically, so that action is disabled.
Revert failures are shown as errors rather than disappearing silently.

## Previews

Images, video, audio, PDFs, HTML and markdown open in a viewer instead of
Monaco. The extension decides (`libs/shared/src/file-kinds.ts`); the size cap does not
apply to media, so a multi-gigabyte video opens and seeks. HTML, SVG and
markdown keep a Preview/Source toggle; the HTML/SVG preview shows the saved
file, and says so while the buffer has unsaved edits. Every other file that
cannot be edited as text gets a card with **Open in default app**, **Quick
Look** (macOS) and **Reveal**.

Markdown renders in-app with the same renderer as chat — GFM tables, Mermaid
diagrams, KaTeX — from the live buffer, so the preview follows unsaved edits.
Relative images resolve over the workspace's `phosphor-file://` document
grant; relative links open in the Files pane like any path link in chat. A
newly created file opens straight in the editor, not as a blank preview.

The viewers load from `phosphor-file://`, which serves only what main granted
by an unguessable token (`apps/desktop/electron/fs/file-protocol.ts`): one file for media
and PDFs, or the workspace for an HTML page or a markdown file, so relative
CSS, images and scripts resolve. Paths are realpath'd and must stay under the grant; `..` and
symlinks out of it get 404. Video streams with Range requests.

A previewed HTML page runs its scripts in `sandbox="allow-scripts"` under a
policy with no network: it can show sibling files but not `fetch` them, and a
page that loads a library from a CDN renders without it — open it externally
for that. Any frame navigating to http(s) or `file:` is cancelled. PDFs use
Chromium's built-in viewer; links in a PDF open in your browser.

**Open in default app** refuses anything the OS would run rather than open —
apps, installers, scripts, shortcuts, and on macOS/Linux any file with an
execute bit — and does not follow symlinks. Reveal it and decide yourself.
