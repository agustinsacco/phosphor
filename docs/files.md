# Files and editor

The Files pane is a lazy workspace explorer beside Monaco editor tabs. Gitignore
and hidden-file filters, git status dots and filesystem watching are always on.
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
  expand, Enter opens. Reveal and copy-path stay in the menu.

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
transfer undo, native document previews.
