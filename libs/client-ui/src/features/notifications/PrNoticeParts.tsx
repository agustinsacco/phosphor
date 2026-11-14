import clsx from 'clsx'
import { TooltipButton } from '@/components/Tooltip'
import { prVerdict, type PrTone } from '@/features/sessions/prVerdict'
import type { GhPrSummary } from '@shared/models'
import { usePrStatusStore } from '@/stores/prStatus'
import { prNoticeAction, type PrNotice } from './prNotice'
import { openPrNotice, runPrNoticeAction } from './prNoticeActions'

/**
 * A PR notice, in parts. The drawer row and the toast compose these, the way
 * lane receipts compose `LaneReceipt.tsx`, so the two never drift apart.
 */

type ToneGroup = 'bad' | 'warn' | 'good' | 'merged' | 'muted'

const GROUP: Record<PrTone, ToneGroup> = {
  failing: 'bad',
  conflict: 'bad',
  closed: 'bad',
  pending: 'warn',
  blocked: 'warn',
  review: 'good',
  ready: 'good',
  merged: 'merged',
  draft: 'muted',
  unknown: 'muted',
}

const BEAD: Record<ToneGroup, string> = {
  bad: 'text-danger bg-danger-soft border-danger/40',
  warn: 'text-warning bg-warning/10 border-warning/40',
  good: 'text-success bg-success/10 border-success/40',
  merged: 'text-merged bg-merged-soft border-merged/40',
  muted: 'text-text-tertiary bg-chip border-border-strong',
}

/** The toast's left edge, in the same tone as the bead. */
export const PR_TONE_BAR: Record<ToneGroup, string> = {
  bad: 'bg-danger',
  warn: 'bg-warning',
  good: 'bg-success',
  merged: 'bg-merged',
  muted: 'bg-border-strong',
}

export const prToneGroup = (summary: GhPrSummary): ToneGroup => GROUP[prVerdict(summary).tone]

/** The PR as it reads now, else as it read when the notice was raised. */
export function useNoticeSummary(notice: Pick<PrNotice, 'key' | 'summary'>): GhPrSummary {
  return usePrStatusStore((s) => s.byKey[notice.key]?.summary) ?? notice.summary
}

/** 10px strokes on a 10px box; shape carries the verdict as well as colour does. */
function ToneMark({ tone }: { tone: PrTone }): React.JSX.Element | null {
  const paths: Partial<Record<PrTone, string>> = {
    failing: 'M3 3l4 4M7 3l-4 4',
    closed: 'M3 3l4 4M7 3l-4 4',
    conflict: 'M5 2.2v3.4M5 7.6v.2',
    blocked: 'M5 2.2v3.4M5 7.6v.2',
    pending: 'M5 2.6V5l1.6 1',
    review: 'M2.6 5.2l1.6 1.6 3.2-3.4',
    ready: 'M1.4 5.2l1.6 1.6 3.2-3.4M5 6.4l.4.4 3.2-3.4',
    merged: 'M3.2 2v6M3.2 4.2c0 1.6 1.4 2.4 3.6 2.4M6.8 6.6v0',
  }
  const d = paths[tone]
  if (!d) return null
  return (
    <svg width={10} height={10} viewBox="0 0 10 10" aria-hidden>
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** The PR's verdict now, as a bead: the sidebar's mark, so a notice and its lane's row match. */
export function PrToneGlyph({
  notice,
}: {
  notice: Pick<PrNotice, 'key' | 'summary'>
}): React.JSX.Element {
  const verdict = prVerdict(useNoticeSummary(notice))
  return (
    <span
      data-testid="pr-notice-glyph"
      data-tone={verdict.tone}
      data-tooltip={`${verdict.word} · ${verdict.headline}`}
      className={clsx(
        'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
        BEAD[GROUP[verdict.tone]],
        verdict.tone === 'draft' && 'border-dashed',
      )}
    >
      <ToneMark tone={verdict.tone} />
    </span>
  )
}

/**
 * Where it is, then what changed since you looked. The lane's name gives way
 * first: `repo#n` always shows whole.
 */
export function PrNoticeLines({
  notice,
  muted = false,
}: {
  notice: Pick<PrNotice, 'changes' | 'lane' | 'ref'>
  muted?: boolean
}): React.JSX.Element {
  return (
    <>
      <span className="text-text-tertiary flex min-w-0 text-sm leading-4">
        <span className="min-w-0 truncate">{notice.lane.title}</span>
        <span className="shrink-0 whitespace-pre">
          {' · '}
          {notice.ref.repo}#{notice.ref.number}
        </span>
      </span>
      <PrNoticeSince notice={notice} muted={muted} className="mt-0.5 leading-4" />
    </>
  )
}

/** "Since you looked: …", once there is more than the headline to say. */
function PrNoticeSince({
  notice,
  muted = false,
  className,
}: {
  notice: Pick<PrNotice, 'changes'>
  muted?: boolean
  className?: string
}): React.JSX.Element | null {
  if (notice.changes.length < 2) return null
  return (
    <span
      data-testid="pr-notice-since"
      className={clsx(
        'block text-sm break-words',
        muted ? 'text-text-tertiary' : 'text-text-secondary',
        className,
      )}
    >
      <span className={clsx('font-medium', muted ? 'text-text-secondary' : 'text-text')}>
        Since you looked:
      </span>{' '}
      {notice.changes.map((change) => change.text).join(' · ')}
    </span>
  )
}

/**
 * Open lane, then the one action that fits the PR now. `done` runs after
 * either, so the caller can mark the notice seen or dismiss its card.
 */
export function PrNoticeActions({
  notice,
  done,
  className,
}: {
  notice: PrNotice
  done?: () => void
  className?: string
}): React.JSX.Element {
  const summary = useNoticeSummary(notice)
  const action = prNoticeAction(summary)
  const run = (work: () => Promise<void>) => (): void => {
    done?.()
    void work().catch(() => undefined)
  }
  return (
    <div className={clsx('flex flex-wrap items-center gap-1.5', className)}>
      <TooltipButton
        onClick={run(() => openPrNotice(notice))}
        className="border-border-strong bg-surface text-text hover:border-text-tertiary rounded-sm border px-2 py-0.5 text-sm font-medium focus-visible:ring-2 focus-visible:ring-[var(--px-accent)]/40 focus-visible:outline-none"
      >
        Open lane
      </TooltipButton>
      {action && (
        <TooltipButton
          onClick={run(() => runPrNoticeAction({ ...notice, summary }, action))}
          className="bg-accent-soft text-accent rounded-sm border border-[color-mix(in_srgb,var(--px-accent)_45%,transparent)] px-2 py-0.5 text-sm font-medium hover:border-[var(--px-accent)] focus-visible:ring-2 focus-visible:ring-[var(--px-accent)]/40 focus-visible:outline-none"
        >
          {action.label}
        </TooltipButton>
      )}
    </div>
  )
}
