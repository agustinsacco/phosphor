import type { GhPrDetail, GhPrSummary, GhPullRequest } from '@shared/models'
import type { PrHandoff } from '../prHandoff'
import { isSummary } from '../prVerdict'
import { agoText } from './prFreshness'
import { mergedBy } from './prActivity'
import { SkeletonRows } from './PrBits'
import { PrChecklist } from './PrChecklist'
import { useNow } from './PrHeader'
import { PrGlyph } from './PrIcons'
import { PrLabelledRail } from './PrStageRail'

function Stats({ summary }: { summary: GhPrSummary }): React.JSX.Element {
  const tiles: [string, string, string][] = [
    [`+${summary.additions.toLocaleString('en-US')}`, 'added', 'text-success font-mono'],
    [`−${summary.deletions.toLocaleString('en-US')}`, 'removed', 'text-danger font-mono'],
    [
      summary.changedFiles.toLocaleString('en-US'),
      summary.changedFiles === 1 ? 'file' : 'files',
      'text-text',
    ],
    [
      summary.comments.toLocaleString('en-US'),
      summary.comments === 1 ? 'comment' : 'comments',
      'text-text',
    ],
  ]
  return (
    <dl className="grid grid-cols-4 gap-1.5">
      {tiles.map(([value, label, tone]) => (
        <div key={label} className="bg-bg-secondary flex flex-col-reverse rounded-md px-2 py-1.5">
          <dt className="text-text-secondary text-sm">{label}</dt>
          <dd className={`truncate text-lg font-semibold tabular-nums ${tone}`}>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Facts a branch listing carries, for a PR not read by number (a Host lane's). */
function BasicFacts({ pr }: { pr: GhPullRequest }): React.JSX.Element {
  const checks = pr.checks
  const facts: [string, string][] = [
    [
      'Checks',
      checks
        ? `${checks.passed} passed, ${checks.failed} failed, ${checks.pending} running`
        : 'Unavailable',
    ],
    [
      'Review',
      pr.reviewDecision === 'APPROVED'
        ? 'Approved'
        : pr.reviewDecision === 'CHANGES_REQUESTED'
          ? 'Changes requested'
          : pr.reviewDecision === 'REVIEW_REQUIRED'
            ? 'Review required'
            : 'Unavailable',
    ],
    [
      'Branch',
      pr.mergeable === 'CONFLICTING'
        ? 'Has merge conflicts'
        : pr.mergeable === 'MERGEABLE'
          ? 'No conflicts'
          : 'Unavailable',
    ],
  ]
  return (
    <dl className="grid grid-cols-[88px_1fr] gap-x-2 gap-y-1.5 px-1 text-base">
      {facts.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-text-secondary">{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function Ended({ summary, detail }: { summary: GhPrSummary; detail?: GhPrDetail }) {
  const now = useNow(30_000)
  if (summary.state === 'CLOSED')
    return (
      <p className="text-danger flex items-center gap-1.5 text-base">
        <PrGlyph glyph="closed" size={14} />
        Closed without merging
        {summary.closedAt ? `, ${agoText(Date.parse(summary.closedAt), now)}` : ''}
      </p>
    )
  const { at, actor } = mergedBy(summary, detail)
  return (
    <p className="text-merged flex items-center gap-1.5 text-base" data-testid="pr-merged-note">
      <PrGlyph glyph="merged" size={14} />
      Merged{at ? ` ${agoText(Date.parse(at), now)}` : ''}
      {actor ? ` by @${actor}` : ''}
    </p>
  )
}

export function PrOverview({
  pr,
  detail,
  loading,
  onHandoff,
  onOpen,
}: {
  pr: GhPullRequest | GhPrSummary | undefined
  detail: GhPrDetail | undefined
  loading: boolean
  onHandoff: (kind: PrHandoff) => void
  onOpen: (url: string) => void
}): React.JSX.Element {
  if (!pr) return <SkeletonRows rows={6} />
  const summary = isSummary(pr) ? pr : undefined
  const ended = pr.state === 'MERGED' || pr.state === 'CLOSED'
  return (
    <div className="space-y-3">
      <PrLabelledRail pr={pr} />
      {summary && <Stats summary={summary} />}
      {summary && ended ? (
        <Ended summary={summary} detail={detail} />
      ) : summary ? (
        <PrChecklist
          summary={summary}
          detail={detail}
          loading={loading}
          onHandoff={onHandoff}
          onOpen={onOpen}
        />
      ) : (
        <BasicFacts pr={pr} />
      )}
    </div>
  )
}
