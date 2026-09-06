# Explorer actions

The explorer now exposes New file and New folder in its toolbar and empty-space
context menu, including empty workspaces. Row menus create inside a folder (or
beside a file), expand the destination, and open new files in Monaco.

Names are single entries, not paths. Duplicate creation and rename destinations
are refused; action errors surface as toasts. Rename retargets descendant editor
buffers without dropping unsaved content. Trash asks for confirmation, warns
about unsaved edits, and closes descendant tabs only after success.

Covered by filesystem/store tests and an Electron flow creating an empty-folder
file, editing it, renaming its parent, then saving to the new path.
