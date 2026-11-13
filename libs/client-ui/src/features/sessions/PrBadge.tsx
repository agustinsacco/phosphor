import clsx from 'clsx'
import type { GhPullRequest } from '@shared/models'
import type { LanePr } from './lanePrs'

/**
 * A row's subtitle names itself `lane-line` (`@container/lane-line`). Narrower
 * than this, it keeps only the lead bead and counts the rest, so the beads
 * never run past the sidebar's edge. Without that container (the Home board)
 * the query never matches and every bead shows.
 */
const NARROW_ONLY = 'hidden @max-[10.5rem]/lane-line:inline'
const WIDE_ONLY = '@max-[10.5rem]/lane-line:hidden'

import { lanePrUrl, prBeads } from './prBeads'
import { PR_TONE_BEAD_CLASSES, PrToneGlyph } from './PrToneGlyph'

/**
 * A lane's own PRs as beads: one verdict-coloured circle with a glyph per PR,
 * lead first, at most three, then `+N`. One tooltip lists every PR.
 *
 * Right-aligned (`ml-auto`) on purpose: down a sidebar the beads form a
 * scannable column instead of floating after a branch name whose width varies
 * per lane. `shrink-0` keeps them whole — the branch segment is the one allowed
 * to truncate.
 *
 * **Each bead is deliberately a `span`, not a `button`.** The whole row is
 * already a `<button>` (see `SessionRow`), and a button inside a button is
 * invalid HTML — the same trap the inline rename editor documents. So a bead
 * is a `role="link"` span with `tabIndex={-1}`: a mouse target, and explicitly
 * NOT a tab stop, because one interactive child per PR would put more stops on
 * every lane in the sidebar.
 *
 * That leaves keyboard users without a path to the PRs, so the row's context
 * menu carries a "Pull requests" submenu with the same targets. The beads are
 * the shortcut; the menu is the accessible route. Changing one without the
 * other regresses it.
 *
 * A lane without a PR renders nothing.
 */
export function PrBadge({ prs }: { prs: LanePr[] }): React.JSX.Element | null {
  if (prs.length === 0) return null
  const view = prBeads(prs)
  return (
    <span
      data-testid="session-pr-badge"
      data-variant={view.tone}
      role="group"
      aria-label={`Pull requests: ${view.lines.join('. ')}`}
      data-tooltip={view.lines.join('\n')}
      data-tooltip-description="Click a bead to open it on GitHub"
      className="ml-auto flex shrink-0 items-center gap-1"
    >
      {view.shown.map((lane, index) => (
        <PrBead key={lane.key} lane={lane} className={index > 0 ? WIDE_ONLY : undefined} />
      ))}
      {view.more > 0 && <MoreCount count={view.more} className={WIDE_ONLY} />}
      {prs.length > 1 && <MoreCount count={prs.length - 1} className={NARROW_ONLY} />}
    </span>
  )
}

function MoreCount({ count, className }: { count: number; className: string }) {
  return (
    <span
      className={clsx('text-text-secondary font-mono text-2xs font-semibold leading-4', className)}
    >
      +{count}
    </span>
  )
}

function PrBead({ lane, className }: { lane: LanePr; className?: string }): React.JSX.Element {
  const url = lanePrUrl(lane)
  const tone = lane.verdict.tone
  return (
    <span
      data-testid="session-pr-bead"
      data-tone={tone}
      role="link"
      tabIndex={-1}
      aria-label={`Open #${lane.number} on GitHub`}
      onClick={(event) => {
        // The row underneath opens the session. Without this, one click both
        // opens the PR in a browser and switches the session out from under it.
        event.stopPropagation()
        event.preventDefault()
        if (url) void openPullRequest({ url })
      }}
      className={clsx(
        'flex size-4 shrink-0 items-center justify-center rounded-full border',
        // Hover derives from the bead's OWN colour (`border-current`) rather
        // than a `dark:` variant: Phosphor themes via a `.dark` CLASS, but no
        // `@custom-variant dark` is defined, so Tailwind's `dark:` would key
        // off the OS preference and be wrong whenever the two disagree.
        url && 'cursor-pointer hover:border-current',
        PR_TONE_BEAD_CLASSES[tone],
        className,
      )}
    >
      <PrToneGlyph tone={tone} />
    </span>
  )
}

/** Open a PR in the user's browser. Shared by the beads and the row menus. */
export function openPullRequest(pr: Pick<GhPullRequest, 'url'>): Promise<void> {
  return window.phosphor.invoke('app:openExternal', pr.url)
}
