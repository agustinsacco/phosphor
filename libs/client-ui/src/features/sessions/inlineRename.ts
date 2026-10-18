/**
 * What an inline rename should actually commit.
 *
 * The sidebar's rename input commits on blur, and blur fires for reasons the
 * user never meant as an edit (clicking elsewhere, the window losing focus,
 * Enter on an untouched field). So the commit rule lives here, away from the
 * component: whitespace-only drafts and no-op edits resolve to `undefined`,
 * which callers treat as "close the editor, send nothing".
 *
 * Returns the trimmed name to apply, or `undefined` for a no-op.
 */
export function committedRename(draft: string, current: string): string | undefined {
  const trimmed = draft.trim()
  if (!trimmed) return undefined
  if (trimmed === current.trim()) return undefined
  return trimmed
}
