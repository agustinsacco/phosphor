# Explorer interaction controller

A workspace-scoped controller provides multi-selection, visible-row keyboard
navigation, copy/cut/paste, import picking and drag/drop. Only explorer-focused
shortcuts act on files. Transfers are serialized within the pane, report
partial failures, and immediately reconcile completed moves with editor state.
A cut clipboard retains failed entries without overwriting a newer clipboard.

External drops always copy; internal drops move unless Option/Ctrl requests a
copy. Selecting a parent and a descendant transfers the parent just once.
Renderer tests cover selection pruning and partial-success reconciliation;
Electron coverage exercises the integrated controls.
