import { useEffect, useState } from 'react'
import clsx from 'clsx'
import type { GhPrSummary } from '@shared/models'
import { tooltipProps } from '@/components/Tooltip'
import { SOURCE_LABEL, type LanePr } from '../lanePrs'
import { isSummary } from '../prVerdict'
import { prChanges } from '../prChanges'
import type { PrSeenEntry } from '@/stores/prSeen'
import { agoText, freshnessText, type PrFreshness } from './prFreshness'
import { PrGlyph, TONE_CHIP, verdictGlyph } from './PrIcons'

/** Re-render every second, for "checked 12s ago". */
export function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

const repoOf = (item: LanePr) =>
  item.ref ? `${item.ref.owner}/${item.ref.repo}#${item.number}` : `#${item.number}`

/**
 * The shown PR's identity, title and where it stands. Its actions sit in
 * `PrHeaderActions`, which comes later in tab order (list, tabs, panel,
 * actions) but is drawn in this header's top-right corner.
 */
export function PrHeader({
  item,
  fresh,
  notes,
}: {
  item: LanePr
  fresh: PrFreshness
  notes: string[]
}): React.JSX.Element {
  const now = useNow()
  const summary = isSummary(item.pr) ? item.pr : undefined
  const freshness = freshnessText(fresh, now)
  const meta = [
    item.source ? SOURCE_LABEL[item.source] : 'Suggested from this lane',
    summary?.author ? `@${summary.author}` : undefined,
  ].filter(Boolean)
  return (
    <div className="px-3 pt-2.5">
      <div className="flex min-h-6 items-center gap-2 pr-28">
        <span className="text-text-secondary min-w-0 truncate font-mono text-base">
          {repoOf(item)}
        </span>
        <span
          data-testid="pr-inspector-verdict"
          className={clsx(
            'flex shrink-0 items-center gap-1 rounded-full border px-1.5 font-mono text-xs font-semibold leading-[18px]',
            TONE_CHIP[item.verdict.tone],
          )}
        >
          <PrGlyph glyph={verdictGlyph(item.verdict)} size={11} />
          {item.verdict.word}
        </span>
      </div>
      <h3
        className="pr-clamp-2 mt-1 text-lg font-semibold leading-snug"
        {...tooltipProps(item.pr?.title)}
      >
        {item.pr?.title ?? 'Reading this pull request…'}
      </h3>
      <p className="text-text-secondary [&>*+*]:before:text-text-tertiary mt-0.5 flex min-w-0 items-center gap-x-1.5 overflow-hidden whitespace-nowrap text-sm leading-5 [&>*+*]:before:mr-1.5 [&>*+*]:before:content-['·']">
        {meta.map((part) => (
          <span key={part} className="shrink-0">
            {part}
          </span>
        ))}
        {summary && (
          <span
            className="min-w-0 truncate font-mono"
            {...tooltipProps(`${summary.headRefName} into ${summary.baseRefName}`)}
          >
            {summary.headRefName} → {summary.baseRefName}
          </span>
        )}
        {fresh.stale ? (
          <span
            data-testid="pr-inspector-stale"
            className="text-warning border-warning/30 bg-warning/10 shrink-0 rounded border px-1 font-mono text-xs leading-4"
            {...tooltipProps(freshness.detail)}
          >
            stale
          </span>
        ) : (
          <span className="text-text-tertiary shrink-0" {...tooltipProps(freshness.detail)}>
            {freshness.text}
          </span>
        )}
      </p>
      {fresh.stale && <p className="sr-only">{freshness.detail}</p>}
      {notes.map((note) => (
        <p key={note} className="text-text-secondary mt-1 text-sm">
          {note}
        </p>
      ))}
    </div>
  )
}

/** "Since you looked (2h ago): Checks green again · @kim approved". */
export function SinceYouLooked({
  baseline,
  summary,
}: {
  baseline: PrSeenEntry | undefined
  summary: GhPrSummary | undefined
}): React.JSX.Element | null {
  const now = useNow(30_000)
  if (!baseline || !summary) return null
  const changes = prChanges(baseline.summary, summary)
  if (!changes.length) return null
  return (
    <p
      data-testid="pr-inspector-since"
      className="bg-accent-soft text-text mx-3 mt-2 rounded-md px-2.5 py-1.5 text-base leading-snug"
    >
      <b className="text-accent font-semibold">
        Since you looked ({agoText(baseline.seenAt, now)}):
      </b>{' '}
      {changes.map((change) => change.text).join(' · ')}
    </p>
  )
}
