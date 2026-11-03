import { useEffect, useId, useRef, useState } from 'react'
import clsx from 'clsx'
import type { GhPullRequest } from '@shared/models'
import { PopupMenu, MenuRow } from '@/components/PopupMenu'
import { TooltipButton } from '@/components/Tooltip'
import { useLanePrefsStore } from '@/stores/lanePrefs'
import { usePullRequestsStore, type RepoPullRequests } from '@/stores/pullRequests'
import { useLanePullRequest } from './useLanePullRequest'
import { prChip, PR_CHIP_CLASSES } from './prChip'

/**
 * A real tab stop in the title bar; sidebar row chips deliberately are not.
 * A lane without a pull request shows nothing: no placeholder, no "no PR".
 * The listing keeps refreshing underneath, so a PR opened later appears.
 */
export function LanePrStatus({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const { repoPath, ready, slice, pr } = useLanePullRequest(sessionId)
  const enabled = useLanePrefsStore((s) => s.lanes.prStatus)
  if (!enabled || !repoPath || !pr) return null
  return (
    <LanePrPill
      key={`${sessionId}:${repoPath}`}
      repoPath={repoPath}
      ready={ready}
      slice={slice}
      pr={pr}
    />
  )
}

interface LanePrProps {
  repoPath: string
  ready: boolean
  slice: RepoPullRequests
  pr: GhPullRequest
}

function LanePrPill({ repoPath, ready, slice, pr }: LanePrProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const id = useId()
  const chip = prChip(pr)
  const close = (): void => {
    setOpen(false)
    triggerRef.current?.focus()
  }
  return (
    <div className="titlebar-no-drag relative shrink-0">
      <TooltipButton
        ref={triggerRef}
        type="button"
        aria-label={`Pull request: ${chip.title}`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
        data-testid="lane-pr-status"
        data-variant={chip.variant}
        className={clsx(
          'rounded-full border px-2 py-0.5 font-mono text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent',
          PR_CHIP_CLASSES[chip.variant],
        )}
      >
        {`${chip.label} ${chip.glyph}`.trim()}
      </TooltipButton>
      {open && (
        <PopupMenu
          id={id}
          triggerRef={triggerRef}
          onClose={close}
          fitViewport
          escapeContainer
          className="absolute left-0 top-full mt-1 w-80 py-2"
        >
          <LanePrContent repoPath={repoPath} ready={ready} slice={slice} pr={pr} />
        </PopupMenu>
      )}
    </div>
  )
}

function LanePrContent({ repoPath, ready, slice, pr }: LanePrProps): React.JSX.Element {
  const [linkError, setLinkError] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector('button')?.focus()
  }, [])
  return (
    <div ref={ref} role="region" aria-label="Pull request details">
      <div className="space-y-2 px-3 pb-2 text-sm">
        <PrDetails pr={pr} />
        <RefreshAge slice={slice} />
        {!ready && <p>Repository unavailable. Reconnect to refresh.</p>}
        {repoPath.startsWith('host:') && (
          <p>The Host may reuse its repository cache for up to 60 seconds.</p>
        )}
        {linkError && <p role="alert">Could not open GitHub. Try again.</p>}
      </div>
      <MenuRow
        active={false}
        onClick={() => {
          setLinkError(false)
          void window.phosphor.invoke('app:openExternal', pr.url).catch(() => setLinkError(true))
        }}
      >
        Open on GitHub ↗
      </MenuRow>
      <MenuRow
        active={false}
        disabled={!ready || slice.loading}
        onClick={() => void usePullRequestsStore.getState().refresh(repoPath, { force: true })}
      >
        {slice.loading ? 'Refreshing…' : 'Refresh'}
      </MenuRow>
    </div>
  )
}

function PrDetails({ pr }: { pr: GhPullRequest }): React.JSX.Element {
  const checks = pr.checks
  return (
    <>
      <p className="font-semibold">
        #{pr.number} {pr.title}
      </p>
      <p>State: {pr.state.toLowerCase()}</p>
      <p>
        Checks:{' '}
        {checks
          ? `${checks.passed} passed · ${checks.failed} failed · ${checks.pending} running · ${checks.total} total`
          : 'unavailable'}
      </p>
      <p>
        Review:{' '}
        {pr.reviewDecision === 'APPROVED'
          ? 'approved'
          : pr.reviewDecision === 'CHANGES_REQUESTED'
            ? 'changes requested'
            : pr.reviewDecision === 'REVIEW_REQUIRED'
              ? 'required'
              : 'unavailable'}
      </p>
      <p>
        Conflicts:{' '}
        {pr.mergeable === 'CONFLICTING'
          ? 'has merge conflicts'
          : pr.mergeable === 'MERGEABLE'
            ? 'none reported'
            : 'unavailable'}
      </p>
    </>
  )
}

function RefreshAge({ slice }: { slice: RepoPullRequests }): React.JSX.Element {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])
  const age = (at: number): string => `${Math.max(0, Math.floor((now - at) / 1_000))}s ago`
  return (
    <div>
      {slice.loading && <p role="status">Refreshing repository…</p>}
      {slice.failed && <p>Last app attempt failed ({age(slice.attemptedAt)}).</p>}
      <p>
        {slice.fetchedAt
          ? `Last successful app refresh: ${age(slice.fetchedAt)}`
          : 'No successful app refresh yet.'}
      </p>
    </div>
  )
}
