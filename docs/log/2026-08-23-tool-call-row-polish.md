# 2026-08-23 — Tool-call row polish: command labels, alignment, no box-in-a-box

Three readability fixes to the activity group's tool rows, all driven by how
badly worktree sessions read (`Ran cd /home/u/src/Phosphor/.phosphor/worktrees/…`).

- **Bash labels drop the workspace path.** `cleanCommandForDisplay` in
  `src/features/chat/tools/toolSummaries.ts` strips a leading
  `cd <workspace> && ` (pi already runs the shell in the session cwd, so the
  prefix is pure noise) and collapses later mentions of the workspace path to
  its folder basename. `ToolCard` passes the session's own `workspacePath`
  (not the globally active workspace — transcripts outlive session switches).
  The expanded bash detail keeps the full raw command.
- **Expanded detail is a section, not a card.** The nested bordered card
  inside the group's card read as box-in-a-box. Expand state moved from
  `ToolCard` up to `ActivityRow`, and the detail renders as a full-width
  `border-t` section of the group card. `ToolDetail` is now exported from
  `ToolCard.tsx` for this.
- **One geometry for every row type.** Tool rows, external-tool rows, the
  `✳ Reasoning` row, and sub-agent rows all share `px-2` + a `w-5` gutter, so
  text starts at the same x everywhere; thought bodies indent to `ml-7` to
  align with the text above them.
- **Zero diff stats hidden.** New `DiffStatBadges` (shared by the collapsed
  row and `EditDetail`) omits a zero half — a created file says `+148`, not
  `+148 −0`.

`cleanCommandForDisplay` is deliberately conservative: no workspace path (or
a `cd` into a _different_ directory) leaves the label untouched, and only the
collapsed label is rewritten — nothing in the stored transcript or the
expanded view changes.
