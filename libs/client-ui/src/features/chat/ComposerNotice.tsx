import clsx from 'clsx'
import type { ReactNode } from 'react'

export type NoticeTone = 'neutral' | 'warning' | 'danger'

const TONE_CLASS: Record<NoticeTone, string> = {
  neutral: 'bg-bg-secondary/60 border-border',
  warning: 'bg-warning/5 border-warning/25',
  danger: 'bg-danger-soft/60 border-danger/25',
}

/** The tone's own text colour, for a notice's leading label. */
export const NOTICE_LABEL_CLASS: Record<NoticeTone, string> = {
  neutral: 'text-text font-medium',
  warning: 'text-warning font-medium',
  danger: 'text-danger font-medium',
}

/** A small icon button inside a notice row: chevrons, dismiss. */
export const NOTICE_ICON_BUTTON_CLASS =
  'text-text-tertiary hover:text-text hover:bg-bg flex size-5 shrink-0 items-center justify-center rounded focus-visible:outline-2 focus-visible:outline-accent'

/** A text action at a notice row's right end. */
export const NOTICE_ACTION_CLASS =
  'text-text-secondary hover:text-text shrink-0 rounded px-1 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent'

/**
 * One compact line above the composer: account limits, background agents,
 * retries. Every notice shares this shell so they stack as one quiet family
 * at the composer's width, instead of each strip picking its own size,
 * padding and weight. Anything longer goes in `details`, under the row.
 */
export function ComposerNotice({
  tone = 'neutral',
  testId,
  details,
  children,
}: {
  tone?: NoticeTone
  testId?: string
  details?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="@container mx-auto w-full max-w-3xl px-1 pb-1.5" data-testid={testId}>
      <div className={clsx('rounded-md border text-sm', TONE_CLASS[tone])}>
        <div className="text-text-secondary flex min-h-7 min-w-0 items-center gap-2 px-2 py-0.5">
          {children}
        </div>
        {details}
      </div>
    </div>
  )
}
