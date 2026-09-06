# Compact IDE panes

Files, Changes, Terminal, Artifacts and Skills share a 6px-corner panel with
no card shadow and a compact, bordered header. Files/Changes use rectangular
2px-corner tabs instead of the enclosing pill. Editor, terminal and artifact
view tabs and pane icon buttons follow the tighter shape.

Theme colors, docking, fullscreen and resize behavior are unchanged. Chat,
modals and artifact-authored content are not restyled. The Electron test
checks shared panel geometry and controls across Files, Terminal and Artifacts
in light and dark themes.
