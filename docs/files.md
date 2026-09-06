# Files and editor

The Files pane pairs a lazy workspace explorer with Monaco editor tabs. Gitignore
and hidden-file filters, git status dots and filesystem watching stay active.

## File management

- **Create:** toolbar buttons create inside the selected folder (beside a selected
  file), or at the workspace root with no selection. Empty-space right-click
  always targets the root; row menus target that row's folder.
- **Rename / Delete:** row menu or F2 / Delete (Cmd+Backspace also works).
  Delete moves to Trash after confirmation and warns about unsaved edits.
  Rename keeps descendant editor buffers; successful deletion closes their tabs.
- **Copy / Cut / Paste:** context menu or Cmd/Ctrl+C, X, V while the explorer
  has focus. Copying beside the original makes a numbered “copy”. Cut moves
  within the active workspace, and clears only successfully moved entries.
- **Multiple entries:** Cmd/Ctrl-click toggles selection, Shift-click selects a
  visible range, Cmd/Ctrl+A selects visible rows. Copy/cut and dragging operate
  on that selection. Rename and Delete require one selected entry.
- **Drop:** drag files or folders from the OS file manager into the tree to
  copy them into the workspace. A folder row targets that folder; a file row
  targets its parent; empty space targets the root. Internal drags move;
  Option/Ctrl-drag copies. The destination highlights while dragging.
- **Import:** right-click → Import files / Import folders opens a native picker.
- **Navigate:** Up/Down and Home/End focus rows; Left/Right collapse/expand
  folders; Enter opens the focused entry. Reveal and copy-path menus remain.

Existing destinations are refused, not merged or replaced. Transfers report
partial failures; completed moves immediately retarget open editors. Copying
folders preserves symlinks without following them. Destinations outside the
workspace, including symlink escapes, and self-nesting are refused. A failed
copy can leave a partial destination; its source remains intact.

The system clipboard accepts incoming Finder/Explorer/Linux file lists;
ordinary copied text is never interpreted as a file. **Outbound file paste
into OS file managers is not implemented** (pidex-to-pidex copy/cut works).
Cross-device moves fail safely; copy then delete explicitly instead.

## Editor

Monaco provides syntax highlighting and its bundled basic language services,
open-file tabs, dirty indicators and Cmd/Ctrl+S. Clean buffers reload on external
changes; dirty ones show a conflict bar. Clicking a file leaves keyboard focus
in the explorer for file shortcuts; click the editor to edit text. Explicit
open-at-line navigation still focuses the editor.

Binary files and files over 4 MB can be managed but are not edited as text.
A debugger, external language servers, split editors, bulk deletion, transfer
undo and native document previews are not part of this file-management change.
