import clsx from 'clsx'
import { receiptDurationLabel, type LaneReceipt } from '@shared/lane-receipt'
import { stripAnsi } from '@shared/ansi'
import { platformName } from '@shared/platform-name'
import { useMachinesStore } from '@/stores/machines'
import { TooltipButton } from '@/components/Tooltip'
import { acknowledgeToast, useExtensionUiStore, type Toast } from '@/stores/extensionUi'
import type { Notification } from '@/stores/notifications'
import { useSessionsStore } from '@/stores/sessions'
import { useLayoutStore } from '@/stores/layout'
import { machineColour, type ToastReceipt } from '@/features/sessions/laneReceipt'

/**
 * A lane's receipt, in parts. The toast shows all of it; a drawer row shows
 * the line and facts, and the rest once expanded. Both surfaces compose these
 * parts, so the two never drift apart.
 */
export type ReceiptNotice = Pick<
  Notification,
  'kind' | 'title' | 'message' | 'receipt' | 'onOpen' | 'sessionId'
>

export async function openReceiptAction(
  notice: ReceiptNotice,
  action: 'changes' | 'retry',
): Promise<void> {
  try {
    await notice.onOpen?.()
    const { activeSessionId, live } = useSessionsStore.getState()
    const entry = activeSessionId ? live[activeSessionId] : undefined
    const matches = notice.receipt?.machineId
      ? entry?.target?.kind === 'remote' &&
        entry.target.hostId === notice.receipt.machineId &&
        entry.laneId === notice.receipt.laneId
      : activeSessionId === notice.sessionId
    if (!matches || !activeSessionId || useLayoutStore.getState().page !== null) return
    if (action === 'changes') useLayoutStore.getState().setRightPane('changes', activeSessionId)
    else document.querySelector<HTMLElement>('textarea[aria-label="Chat message"]')?.focus()
  } catch {
    // Failed navigation never changes another lane's pane or composer.
  }
}

function stopped(notice: ReceiptNotice): boolean {
  return notice.receipt?.facts?.outcome === 'error' || notice.kind === 'error'
}

/** The lane's name without the "machine · " prefix a Host notice carries: the origin says it. */
export function receiptTitle(notice: ReceiptNotice): string {
  const receipt = notice.receipt
  const title = notice.title ?? receipt?.facts?.title ?? 'Untitled lane'
  const prefix = `${receipt?.machine} · `
  return receipt?.machineId && title.startsWith(prefix) ? title.slice(prefix.length) : title
}

/** Which machine ran it, and a Host's platform in words. */
export function ReceiptOrigin({ receipt }: { receipt: ToastReceipt }): React.JSX.Element {
  const platform = useMachinesStore(
    (s) => s.machines.find((machine) => machine.id === receipt.machineId)?.platform,
  )
  return (
    <span className="border-border shrink-0 rounded border px-1.5 py-0.5 text-xs">
      {receipt.machine}
      {platform ? ` · ${platformName(platform)}` : ''}
    </span>
  )
}

/** Repository and branch, when the receipt knows them. */
export function ReceiptPlace({ facts }: { facts?: LaneReceipt }): React.JSX.Element | null {
  if (!facts?.repository && !facts?.branch) return null
  return (
    <span className="text-text-tertiary block min-w-0 truncate text-sm">
      {[facts.repository, facts.branch && `⎇ ${facts.branch}`].filter(Boolean).join(' · ')}
    </span>
  )
}

/** The reply's line, or why it stopped. Falls back to the notice's own message. */
export function NoticeLine({
  notice,
  muted = false,
  className,
}: {
  notice: ReceiptNotice
  muted?: boolean
  className?: string
}): React.JSX.Element {
  const excerpt = notice.receipt?.facts?.excerpt
  const isStopped = stopped(notice)
  return (
    <span
      className={clsx(
        'block text-sm break-words',
        isStopped ? 'text-danger' : muted ? 'text-text-tertiary' : 'text-text-secondary',
        className,
      )}
    >
      {excerpt ? `${isStopped ? 'Stopped: ' : ''}${stripAnsi(excerpt)}` : stripAnsi(notice.message)}
    </span>
  )
}

/** Duration, files changed, tests and artifacts: only the ones the run has. */
export function ReceiptFacts({
  facts,
  className,
}: {
  facts?: LaneReceipt
  className?: string
}): React.JSX.Element | null {
  if (
    !facts ||
    (facts.durationMs === null && facts.files === 0 && facts.tests === null && !facts.artifacts)
  )
    return null
  return (
    <span
      className={clsx('text-text-secondary flex flex-wrap gap-x-3 gap-y-1 text-xs', className)}
      data-testid="receipt-facts"
    >
      {facts.durationMs !== null && <span>{receiptDurationLabel(facts.durationMs)}</span>}
      {facts.files > 0 && (
        <span>
          {facts.files} {facts.files === 1 ? 'file' : 'files'}{' '}
          <span className="text-success">+{facts.added}</span>{' '}
          <span className="text-danger">-{facts.removed}</span>
        </span>
      )}
      {facts.tests && (
        <span className={facts.tests === 'failed' ? 'text-danger' : 'text-success'}>
          {facts.tests === 'passed' ? 'tests pass' : 'tests failed'}
        </span>
      )}
      {facts.artifacts > 0 && (
        <span>
          {facts.artifacts} {facts.artifacts === 1 ? 'artifact' : 'artifacts'}
        </span>
      )}
    </span>
  )
}

/** Open lane, then View changes when files changed and Retry when it stopped. */
export function ReceiptActions({
  notice,
  open,
  done,
  className,
}: {
  notice: ReceiptNotice
  open?: () => void
  /** After View changes or Retry has gone to the lane. */
  done?: () => void
  className?: string
}): React.JSX.Element {
  const act = (action: 'changes' | 'retry') => () => {
    void openReceiptAction(notice, action).then(done)
  }
  return (
    <div className={clsx('flex gap-3 text-xs', className)}>
      <TooltipButton onClick={open} className="text-accent font-medium">
        Open lane
      </TooltipButton>
      {!!notice.receipt?.facts?.files && (
        <TooltipButton onClick={act('changes')}>View changes</TooltipButton>
      )}
      {stopped(notice) && <TooltipButton onClick={act('retry')}>Retry</TooltipButton>}
    </div>
  )
}

/** The receipt as a toast: everything at once, edged in its machine's colour. */
export function LaneReceiptCard({
  toast,
  open,
}: {
  toast: Toast
  open?: () => void
}): React.JSX.Element {
  const receipt = toast.receipt
  const age = receipt ? Math.max(0, Math.floor((Date.now() - Date.parse(receipt.at)) / 60000)) : 0
  const dismiss = (): void => {
    useExtensionUiStore.getState().setToastsPaused('hover', false)
    acknowledgeToast(toast)
  }
  return (
    <div
      className="flex min-w-0 flex-1 flex-col rounded-l-xl border-l-[3px]"
      style={{ borderLeftColor: machineColour(receipt?.machineId) }}
    >
      <TooltipButton
        onClick={open}
        aria-label={`Open lane: ${toast.title ?? receiptTitle(toast)}`}
        data-testid="toast-open"
        className="min-w-0 p-3 text-left"
      >
        <span className="text-text-secondary flex items-center justify-between text-xs">
          {receipt && <ReceiptOrigin receipt={receipt} />}
          <time dateTime={receipt?.at}>{age ? `${age}m ago` : 'Just now'}</time>
        </span>
        <strong className="text-text mt-1 block truncate text-base">{receiptTitle(toast)}</strong>
        <ReceiptPlace facts={receipt?.facts} />
        <NoticeLine notice={toast} className="truncate" />
        <ReceiptFacts facts={receipt?.facts} className="mt-2" />
      </TooltipButton>
      <ReceiptActions notice={toast} open={open} done={dismiss} className="px-3 pb-3" />
    </div>
  )
}
