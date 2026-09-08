import clsx from 'clsx'
import type { GhPullRequest } from '@shared/models'
import { prChip, noPrChip, type PrChipVariant } from './prChip'

/**
 * Per-variant colours. `soft` grounds plus a tinted border, so the chip stays
 * legible on all three row grounds (sidebar, hover, active) without a fill
 * strong enough to compete with the lane title.
 */
const VARIANTS: Record<PrChipVariant, string> = {
  open: 'text-success bg-success/10 border-success/25',
  approved: 'text-success bg-success/10 border-success/25',
  failing: 'text-danger bg-danger-soft border-danger/30',
  pending: 'text-warning bg-warning/10 border-warning/25',
  blocked: 'text-warning bg-warning/10 border-warning/25',
  conflict: 'text-danger bg-danger-soft border-danger/25',
  draft: 'text-text-tertiary bg-chip border-transparent',
  merged: 'text-merged bg-merged-soft border-merged/25',
  closed: 'text-danger bg-danger-soft border-danger/25',
  'no-pr': 'text-text-tertiary bg-chip border-transparent',
}

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
 * `pr={null}` renders the "no PR yet" fallback instead — still a chip (same
 * column, same width discipline), but not a link: there is nothing to open.
 */
export function PrBadge({ pr }: { pr: GhPullRequest | null }): React.JSX.Element {
  const chip = pr ? prChip(pr) : noPrChip()
  return (
    <span
      data-testid="session-pr-badge"
      data-variant={chip.variant}
      role={pr ? 'link' : undefined}
      tabIndex={-1}
      aria-label={pr ? `${chip.title}. Open on GitHub` : chip.title}
      title={pr ? `${chip.title}\nClick to open on GitHub` : chip.title}
      onClick={
        pr
          ? (event) => {
              // The row underneath opens the session. Without this, one click
              // both opens the PR in a browser and switches the session out
              // from under it.
              event.stopPropagation()
              event.preventDefault()
              void openPullRequest(pr)
            }
          : undefined
      }
      className={clsx(
        'ml-auto flex shrink-0 items-center gap-0.5 rounded-full border px-1.5 font-mono text-2xs font-semibold',
        // Hover derives from the chip's OWN colour (`border-current`) rather
        // than a `dark:` variant: Phosphor themes via a `.dark` CLASS, but no
        // `@custom-variant dark` is defined, so Tailwind's `dark:` would key
        // off the OS preference and be wrong whenever the two disagree. No
        // other component in the renderer uses `dark:` either.
        pr && 'cursor-pointer hover:border-current hover:underline hover:underline-offset-2',
        VARIANTS[chip.variant],
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
