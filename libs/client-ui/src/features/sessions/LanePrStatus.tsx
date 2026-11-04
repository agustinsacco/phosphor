import { useEffect, useId, useRef, useState } from 'react'
import clsx from 'clsx'
import type { GhPullRequest } from '@shared/models'
import { PopupMenu, MenuRow } from '@/components/PopupMenu'
import { TooltipButton } from '@/components/Tooltip'
import { useLanePrefsStore } from '@/stores/lanePrefs'
import { usePullRequestsStore, type RepoPullRequests } from '@/stores/pullRequests'
import { useLanePullRequest } from './useLanePullRequest'
import { prChip, noPrChip, PR_CHIP_CLASSES } from './prChip'

/** A real tab stop in the title bar; sidebar row chips deliberately are not. */
export function LanePrStatus({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const status = useLanePullRequest(sessionId)
  const enabled = useLanePrefsStore((s) => s.lanes.prStatus)
  if (!enabled || !status.repoPath) return null
  return (
    <LanePrPill key={`${sessionId}:${status.repoPath}`} {...status} repoPath={status.repoPath} />
  )
}

function LanePrPill({
  repoPath,
  ready,
  slice,
  pr,
  confirmedNoPr,
  branch,
}: {
  repoPath: string
  ready: boolean
  slice: RepoPullRequests
  pr: GhPullRequest | undefined
  confirmedNoPr: boolean
  branch?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const id = useId()
  const chip = pr ? prChip(pr) : confirmedNoPr ? noPrChip() : null
  const close = (): void => {
    setOpen(false)
    triggerRef.current?.focus()
  }
  return (
    <div className="titlebar-no-drag relative shrink-0">
      <TooltipButton
        ref={triggerRef}
        type="button"
        aria-label={chip ? `Pull request: ${chip.title}` : 'Pull request status unavailable'}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
        data-testid="lane-pr-status"
        data-variant={chip?.variant}
        className={clsx(
          'rounded-full border px-2 py-0.5 font-mono text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent',
          chip ? PR_CHIP_CLASSES[chip.variant] : 'text-text-tertiary border-border',
        )}
      >
        {chip ? `${chip.label} ${chip.glyph}`.trim() : slice.loading ? 'PR …' : 'PR ?'}
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
          <LanePrContent
            repoPath={repoPath}
            ready={ready}
            slice={slice}
            pr={pr}
            confirmedNoPr={confirmedNoPr}
            branch={branch}
          />
        </PopupMenu>
      )}
    </div>
  )
}

function LanePrContent({
  repoPath,
  ready,
  slice,
  pr,
  confirmedNoPr,
  branch,
}: {
  repoPath: string
  ready: boolean
  slice: RepoPullRequests
  pr: GhPullRequest | undefined
  confirmedNoPr: boolean
  branch?: string
}): React.JSX.Element {
  const [linkError, setLinkError] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector('button')?.focus()
  }, [])
  return (
    <div ref={ref} role="region" aria-label="Pull request details">
      <div className="space-y-2 px-3 pb-2 text-sm">
        {pr ? (
          <PrDetails pr={pr} />
        ) : (
          <p>{confirmedNoPr ? noPrChip().title : 'Pull request status unavailable'}</p>
        )}
        <RefreshAge slice={slice} branch={branch} />
        {!ready && <p>Repository unavailable. Reconnect to refresh.</p>}
        {!slice.coverage && repoPath.startsWith('host:') && (
          <p>The Host may reuse its repository cache for up to 60 seconds.</p>
        )}
        {linkError && <p role="alert">Could not open GitHub. Try again.</p>}
      </div>
      {pr && (
        <MenuRow
          active={false}
          onClick={() => {
            setLinkError(false)
            void window.phosphor.invoke('app:openExternal', pr.url).catch(() => setLinkError(true))
          }}
        >
          Open on GitHub ↗
        </MenuRow>
      )}
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

function RefreshAge({
  slice,
  branch,
}: {
  slice: RepoPullRequests
  branch?: string
}): React.JSX.Element {
  const coverage = branch ? slice.coverage?.[branch] : undefined
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])
  const age = (at: number): string => `${Math.max(0, Math.floor((now - at) / 1_000))}s ago`
  return (
    <div>
      {slice.loading && <p role="status">Refreshing repository…</p>}
      {slice.coverage
        ? coverage?.state === 'unavailable' && (
            <p>
              Last upstream attempt failed ({age(coverage.attemptedAt)}).{' '}
              {coverage.checkedAt > 0 ? 'Showing stale status.' : 'Status unavailable.'}
            </p>
          )
        : slice.failed && <p>Last app attempt failed ({age(slice.attemptedAt)}).</p>}
      <p>
        {slice.coverage
          ? coverage?.checkedAt
            ? `Last upstream check: ${age(coverage.checkedAt)}`
            : 'No successful upstream check yet.'
          : slice.fetchedAt
            ? `Last successful app refresh: ${age(slice.fetchedAt)}`
            : 'No successful app refresh yet.'}
      </p>
    </div>
  )
}
