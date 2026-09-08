import clsx from 'clsx'
import type { DividerItem } from '../reducer'
import { formatTokens } from '@/lib/format'

/** Compaction / branch-summary / error separators in the message stream. */

export function Divider({ item }: { item: DividerItem }): React.JSX.Element {
  const [label, tone] =
    item.variant === 'compaction'
      ? [
          `Context compacted${item.tokensBefore ? ` — ${formatTokens(item.tokensBefore)} tokens summarized` : ''}`,
          'default' as const,
        ]
      : item.variant === 'branchSummary'
        ? ['Branched from earlier conversation', 'default' as const]
        : [item.summary ?? 'Error', 'error' as const]

  return (
    <DividerShell label={label} tone={tone}>
      {item.variant !== 'error' && item.summary ? (
        <details className="text-text-secondary mx-auto mt-1 max-w-lg text-base">
          <summary className="text-text-tertiary hover:text-text cursor-pointer text-center text-sm">
            show summary
          </summary>
          <div className="border-border bg-surface mt-1.5 max-h-56 overflow-auto rounded-lg border px-3 py-2 whitespace-pre-wrap break-words">
            {item.summary}
          </div>
        </details>
      ) : null}
    </DividerShell>
  )
}

export function DividerShell({
  label,
  tone,
  children,
}: {
  label: string
  tone: 'default' | 'error'
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div>
      <div
        className={clsx(
          'flex items-center gap-2.5 text-sm',
          tone === 'error' ? 'text-danger' : 'text-text-tertiary',
        )}
      >
        <span className={clsx('h-px flex-1', tone === 'error' ? 'bg-danger/30' : 'bg-border')} />
        <span className="max-w-[80%] truncate">{label}</span>
        <span className={clsx('h-px flex-1', tone === 'error' ? 'bg-danger/30' : 'bg-border')} />
      </div>
      {children}
    </div>
  )
}
