import clsx from 'clsx'
import type { HTMLAttributes } from 'react'

/**
 * The rounded label every "where am I / what is this" chip in a header draws.
 *
 * Shape only, never a colour. A chip's ground and ink are its theme: the
 * workspace and branch chips sit on `bg-bg-secondary`, a Host's machine label
 * on `bg-chip`, a pull request's on its verdict tone (`pr-inspector/PrIcons`
 * `TONE_CHIP`). The top bar had all three hand-writing this same radius,
 * padding, gap and type size until this file existed, so a spacing change was
 * four edits that drifted. Put a colour in here and you have given every chip
 * in the app one theme.
 *
 * `inline-flex` rather than `flex` so a chip dropped in a plain block (a pane
 * title, a padded row) shrinks to its label instead of filling the line. Inside
 * a flex row — the top bar, a pane header — it is blockified and behaves as
 * `flex` anyway. `min-w-0` is what lets the label inside truncate.
 *
 * `cursor-pointer` is deliberately absent: `styles/index.css` gives every
 * enabled `button` one, and says so.
 */
export const CHIP =
  'inline-flex min-w-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-sm transition-colors'

/** A mark inside a chip — the `wt` of a worktree. Smaller radius, smaller type. */
export const CHIP_MARK = 'rounded px-1 text-2xs font-medium'

/** A non-interactive chip: a Host's repository, branch or machine name. */
export function Chip({ className, ...props }: HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return <span {...props} className={clsx(CHIP, className)} />
}
