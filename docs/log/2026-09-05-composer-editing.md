# Safe composer editing

An Electron regression reproduced Bold formatting that could not be undone. The
shared textarea now records minimal `insertText` edits in Chromium's native edit
history, then applies the controlled value/selection. This deprecated API is used
only for its undo buffer, not HTML or clipboard access; unsupported harnesses fall
back to controlled editing. Replacement boundaries preserve astral characters.

IME key handling runs before popup/history/send handlers (composition events,
native isComposing and legacy keyCode 229). Shift+Enter over selected list text
keeps native replacement behavior. Both Home and live composers inherit the fix.
Tests exercise real Electron Undo/Redo and synthetic IME events; actual OS input
methods remain a manual cross-platform check, not a claimed certification.
