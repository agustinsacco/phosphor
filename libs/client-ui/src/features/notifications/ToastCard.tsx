import clsx from 'clsx'
import { stripAnsi } from '@shared/ansi'
import { CloseIcon } from '@/components/icons'
import { TooltipButton } from '@/components/Tooltip'
import { machineColour } from '@/features/sessions/laneReceipt'
import { acknowledgeToast, useExtensionUiStore, type Toast } from '@/stores/extensionUi'
import { LaneReceiptCard } from './LaneReceipt'
import { NoticeGlyph } from './NoticeGlyph'
import {
  PR_TONE_BAR,
  PrNoticeActions,
  PrNoticeLines,
  PrToneGlyph,
  prToneGroup,
  useNoticeSummary,
} from './PrNoticeParts'
import type { PrNotice } from './prNotice'

const KIND_BAR: Record<Toast['kind'], string> = {
  error: 'bg-danger',
  warning: 'bg-warning',
  success: 'bg-success',
  info: 'bg-border-strong',
}

/** The focus ring, inset: the card clips its corners, so an outer ring would be cut. */
const FOCUS =
  'outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--px-accent)]/40'

/**
 * One toast: a square card on the drawer's grammar. A tone bar down the left
 * edge (the lane's machine colour for a receipt, the PR's verdict for a PR
 * notice, otherwise the kind), then the glyph, a title line, its line and
 * any actions, like a drawer row. Every kind shares the raised surface and
 * the hairline border; the bar and glyph carry the tone.
 */
export function ToastCard({ toast }: { toast: Toast }): React.JSX.Element {
  const { setToastsPaused } = useExtensionUiStore.getState()
  const hold = (): void => setToastsPaused('hover', true)
  const release = (): void => setToastsPaused('hover', false)
  const open = toast.onOpen
    ? (): void => {
        release()
        void Promise.resolve(toast.onOpen?.()).catch(() => undefined)
        acknowledgeToast(toast)
      }
    : undefined
  const dismiss = (): void => {
    release()
    acknowledgeToast(toast)
  }
  return (
    // The row collapses its own height on exit, so the cards below glide up
    // into the gap instead of jumping. The card's bottom margin (not a flex
    // gap, not padding on the inner box) spaces the cards: a gap would not
    // collapse with the row, and padding cannot shrink, so the stack would
    // snap by that much when the row unmounts.
    <li
      className="toast-row"
      data-leaving={toast.leaving || undefined}
      data-testid="toast"
      data-kind={toast.kind}
    >
      <div className="toast-row-inner px-2">
        <div
          role={toast.kind === 'error' ? 'alert' : undefined}
          data-bump={toast.bump % 2 === 1 ? 'odd' : toast.bump > 0 ? 'even' : undefined}
          onMouseEnter={hold}
          onMouseLeave={release}
          onFocus={hold}
          onBlur={release}
          className={clsx(
            'toast-card group border-border-strong bg-surface-raised pointer-events-auto relative mb-2 flex items-stretch overflow-hidden rounded-sm border shadow-md',
            open && 'hover:border-text-tertiary',
          )}
        >
          <ToneBar toast={toast} />
          {toast.pr ? (
            <PrToastBody toast={toast} pr={toast.pr} open={open} done={dismiss} />
          ) : toast.receipt ? (
            <LaneReceiptCard toast={toast} open={open} />
          ) : open ? (
            <TooltipButton
              type="button"
              onClick={open}
              aria-label={
                toast.openLabel ? `${toast.openLabel}: ${toast.title ?? toast.message}` : undefined
              }
              data-testid="toast-open"
              className={clsx(
                'flex min-w-0 flex-1 cursor-pointer items-start gap-2 py-2 pl-2.5 text-left',
                FOCUS,
              )}
            >
              <ToastBody toast={toast} />
            </TooltipButton>
          ) : (
            <div className="flex min-w-0 flex-1 items-start gap-2 py-2 pl-2.5">
              <ToastBody toast={toast} />
            </div>
          )}
          <DismissButton onClick={dismiss} />
        </div>
      </div>
    </li>
  )
}

function DismissButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <TooltipButton
      type="button"
      onClick={onClick}
      aria-label="Dismiss"
      className={clsx(
        'text-text-tertiary hover:text-text flex size-7 shrink-0 items-center justify-center self-start',
        FOCUS,
      )}
    >
      <CloseIcon size={10} strokeWidth={2.5} />
    </TooltipButton>
  )
}

function ToneBar({ toast }: { toast: Toast }): React.JSX.Element {
  if (toast.pr) return <PrToneBar pr={toast.pr} />
  const colour = toast.receipt ? undefined : KIND_BAR[toast.kind]
  return (
    <span
      aria-hidden
      data-testid="toast-bar"
      className={clsx('w-[3px] shrink-0', colour)}
      style={toast.receipt ? { background: machineColour(toast.receipt.machineId) } : undefined}
    />
  )
}

function PrToneBar({ pr }: { pr: PrNotice }): React.JSX.Element {
  const group = prToneGroup(useNoticeSummary(pr))
  return (
    <span
      aria-hidden
      data-testid="toast-bar"
      className={clsx('w-[3px] shrink-0', PR_TONE_BAR[group])}
    />
  )
}

/** Glyph, title (with what a click does, on hover) and the line. */
function ToastBody({ toast }: { toast: Toast }): React.JSX.Element {
  return (
    <>
      <NoticeGlyph toast={toast} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {toast.title && (
          <span className="flex min-w-0 items-baseline gap-2">
            <span
              className="text-text min-w-0 truncate text-base leading-5 font-medium"
              data-tooltip={toast.title}
            >
              {toast.title}
            </span>
            {toast.openLabel && (
              <span className="toast-open-hint text-text-tertiary ml-auto shrink-0 text-sm">
                {toast.openLabel} →
              </span>
            )}
          </span>
        )}
        <span
          className={clsx(
            'line-clamp-3 break-words',
            toast.title ? 'text-text-secondary text-sm leading-4' : 'text-text text-base leading-5',
          )}
        >
          {stripAnsi(toast.message)}
        </span>
      </span>
    </>
  )
}

/** A PR notice: the drawer row's parts, all at once. */
function PrToastBody({
  toast,
  pr,
  open,
  done,
}: {
  toast: Toast
  pr: PrNotice
  open?: () => void
  done: () => void
}): React.JSX.Element {
  const title = toast.title ?? toast.message
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5 py-2 pl-2.5">
      <TooltipButton
        type="button"
        onClick={open}
        aria-label={`Open lane: ${title}`}
        data-testid="toast-open"
        className={clsx('flex min-w-0 items-start gap-2 text-left', FOCUS)}
      >
        <PrToneGlyph notice={pr} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-text line-clamp-2 text-base leading-5 font-medium break-words">
            {title}
          </span>
          <PrNoticeLines notice={pr} place={toast.message} />
        </span>
      </TooltipButton>
      <PrNoticeActions notice={pr} done={done} className="pl-6" />
    </div>
  )
}
