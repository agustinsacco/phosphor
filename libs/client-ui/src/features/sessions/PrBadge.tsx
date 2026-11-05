import clsx from 'clsx'
import type { GhPullRequest } from '@shared/models'
import { prChip, PR_CHIP_CLASSES } from './prChip'

/**
 * The PR chip on a lane row, and the shortcut to the PR itself.
 *
 * Right-aligned (`ml-auto`) on purpose: down a sidebar the chips form a
 * scannable column instead of floating after a branch name whose width varies
 * per lane. `shrink-0` keeps it whole — the branch segment is the one allowed
 * to truncate.
 *
 * **Deliberately a `span`, not a `button`.** The whole row is already a
 * `<button>` (see `SessionRow`), and a button inside a button is invalid HTML —
 * the same trap the inline rename editor documents. So this is a `role="link"`
 * span with `tabIndex={-1}`: it is a mouse target, and it is explicitly NOT a
 * tab stop, because adding one interactive child per row would put a second
 * stop on every lane in the sidebar.
 *
 * That leaves keyboard users without a path to the PR, so the row's context
 * menu carries an "Open pull request" item. The chip is the shortcut; the menu
 * is the accessible route. Changing one without the other regresses it.
 *
 * A lane without a PR renders no chip at all: callers pass only a real PR.
 */
export function PrBadge({ pr }: { pr: GhPullRequest }): React.JSX.Element {
  const chip = prChip(pr)
  return (
    <span
      data-testid="session-pr-badge"
      data-variant={chip.variant}
      role="link"
      tabIndex={-1}
      aria-label={`${chip.title}. Open on GitHub`}
      data-tooltip={`${chip.title}\nClick to open on GitHub`}
      onClick={(event) => {
        // The row underneath opens the session. Without this, one click both
        // opens the PR in a browser and switches the session out from under it.
        event.stopPropagation()
        event.preventDefault()
        void openPullRequest(pr)
      }}
      className={clsx(
        'ml-auto flex shrink-0 items-center gap-0.5 rounded-full border px-1.5 font-mono text-2xs font-semibold',
        // Hover derives from the chip's OWN colour (`border-current`) rather
        // than a `dark:` variant: Phosphor themes via a `.dark` CLASS, but no
        // `@custom-variant dark` is defined, so Tailwind's `dark:` would key
        // off the OS preference and be wrong whenever the two disagree. No
        // other component in the renderer uses `dark:` either.
        'cursor-pointer hover:border-current hover:underline hover:underline-offset-2',
        PR_CHIP_CLASSES[chip.variant],
      )}
    >
      {chip.label}
      {chip.glyph && <span aria-hidden>{chip.glyph}</span>}
    </span>
  )
}

/** Open a PR in the user's browser. Shared by the chip and the context menu. */
export function openPullRequest(pr: GhPullRequest): Promise<void> {
  return window.phosphor.invoke('app:openExternal', pr.url)
}
