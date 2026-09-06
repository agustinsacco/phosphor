# Composer controls

Home and live chat share a visible formatting row: bold, italic, inline/fenced
code, lists and Markdown links. One binding table drives the controls, keymap and
shortcut reference. Link insertion selects its destination; plain Cmd/Ctrl+K stays
the palette, distinct from the link chord. Controls are disabled during IME entry.

Expand input (Cmd/Ctrl+Shift+X) keeps the same textarea, selection and draft, with
viewport-bounded height; collapse restores the 240px cap. Existing markdown/list,
attachment, draft and streaming semantics remain. Stale references to the removed
Shift+Tab orchestrator-mode switch were corrected; it means outdent/focus now.

Coverage exercises toolbar/shortcut formatting, native undo, links, expansion and
selection retention in both composers. No rich-text document model or dependency
was introduced.
