# Composer density and one-line lanes

The formatting toolbar shipped in [#198](https://github.com/agustinsacco/Phosphor/pull/198)
made the resting composer three rows tall — field, a strip of seven glyph
buttons, then the footer — for commands that already had chords. The strip is
gone. Bold, italic, inline code, code block, both lists, links and
Cmd/Ctrl+Shift+X expansion keep working from the keyboard and stay listed in
Settings → Keybindings; `formattingActions.ts` remains the one source.

Steer now / Queue follow-up now render only while a turn is running **and** the
draft has content. They previously sat there disabled through every idle
streaming moment, spending a row on controls that could not be used.

Sidebar titles are one truncated line again. Two-line clamping re-flowed the
whole list as the divider moved, so lane rows changed height while dragging;
the full title is still the row's tooltip.

Lane rows dropped their spend trailer with the same reasoning: a dollar figure
per lane is a detail, not a way to choose a lane, and it competed with the
branch for the row's one truncating slot. Spend is still one right-click away
("Copy spend"), and unchanged in the Home ledger and the context meter.
Settings → Workspaces → "PR status on lanes" now only decides whether the chip
renders, since there is no longer a cost for it to replace.

Unchanged: send semantics (Enter steers, Alt/Cmd/Ctrl+Enter queues), undo-safe
formatting, IME guards, drafts, fonts, diff preferences and pane chrome.
