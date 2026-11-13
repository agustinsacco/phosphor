import { useEffect, useState } from 'react'
import type { GhPullRequest } from '@shared/models'
import { MenuRow } from '@/components/PopupMenu'
import { useLanePrefsStore } from '@/stores/lanePrefs'
import { usePullRequestsStore, type RepoPullRequests } from '@/stores/pullRequests'
import { usePrStatusStore } from '@/stores/prStatus'
import { useLanePullRequests } from './useLanePrs'
import { laneStatusRefs, type LanePr, type LanePrs } from './lanePrs'
import { prChip, PR_CHIP_CLASSES } from './prChip'
import { LaneHeaderPill } from './LaneHeaderPill'

/**
 * A real tab stop in the title bar; sidebar row chips deliberately are not.
 * A lane without a pull request shows nothing: no placeholder, no "no PR".
 * The listing keeps refreshing underneath, so a PR opened later appears.
 */
export function LanePrStatus({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const { repoPath, ready, slice, prs, lead, branch } = useLanePullRequests(sessionId)
  const enabled = useLanePrefsStore((s) => s.lanes.prStatus)
  // A PR the lane opened elsewhere has no status until its first read: no placeholder.
  if (!enabled || !repoPath || !lead?.pr) return null
  return (
    <LanePrPill
      key={`${sessionId}:${repoPath}`}
      repoPath={repoPath}
      ready={ready}
      slice={slice}
      prs={prs}
      lead={lead}
      pr={lead.pr}
      branch={lead.source === 'checkout' ? branch : undefined}
    />
  )
}

interface LanePrProps {
  repoPath: string
  ready: boolean
  slice: RepoPullRequests
  prs: LanePrs
  lead: LanePr
  pr: GhPullRequest
  branch?: string
}

function LanePrPill(props: LanePrProps): React.JSX.Element {
  const chip = prChip(props.pr)
  const more = props.prs.owned.length - 1
  return (
    <LaneHeaderPill
      label={`Pull request: ${chip.title}${more > 0 ? `, and ${more} more` : ''}`}
      testId="lane-pr-status"
      variant={chip.variant}
      className={PR_CHIP_CLASSES[chip.variant]}
      face={
        <>
          {`${chip.label} ${chip.glyph}`.trim()}
          {more > 0 && <span className="opacity-70">+{more}</span>}
        </>
      }
      region="Pull request details"
    >
      {() => <LanePrContent {...props} />}
    </LaneHeaderPill>
  )
}

function refreshAll(repoPath: string, prs: LanePrs): void {
  void usePullRequestsStore.getState().refresh(repoPath, { force: true })
  void usePrStatusStore.getState().refresh(laneStatusRefs(prs), { force: true })
}

function LanePrContent({
  repoPath,
  ready,
  slice,
  prs,
  pr,
  branch,
}: LanePrProps): React.JSX.Element {
  const [linkError, setLinkError] = useState(false)
  return (
    <>
      <div className="space-y-2 px-3 pb-2 text-sm">
        <PrDetails pr={pr} />
        <RefreshAge slice={slice} branch={branch} />
        {prs.owned.length > 1 && (
          <p>
            Also in this lane:{' '}
            {prs.owned
              .slice(1)
              .map((lane) => `#${lane.number}`)
              .join(', ')}
          </p>
        )}
        {!ready && <p>Repository unavailable. Reconnect to refresh.</p>}
        {!slice.coverage && repoPath.startsWith('host:') && (
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
        onClick={() => refreshAll(repoPath, prs)}
      >
        {slice.loading ? 'Refreshing…' : 'Refresh'}
      </MenuRow>
    </>
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
