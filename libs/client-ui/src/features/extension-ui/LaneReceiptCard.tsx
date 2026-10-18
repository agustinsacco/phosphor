import { receiptDurationLabel } from '@shared/lane-receipt'
import { stripAnsi } from '@shared/ansi'
import { useMachinesStore } from '@/stores/machines'
import { TooltipButton } from '@/components/Tooltip'
import { useExtensionUiStore, type Toast } from '@/stores/extensionUi'
import { useSessionsStore } from '@/stores/sessions'
import { useLayoutStore } from '@/stores/layout'
import { machineColour } from '@/features/sessions/laneReceipt'

export async function openReceiptAction(toast: Toast, action: 'changes' | 'retry'): Promise<void> {
  try {
    await toast.onOpen?.()
    const { activeSessionId, live } = useSessionsStore.getState()
    const entry = activeSessionId ? live[activeSessionId] : undefined
    const matches = toast.receipt?.machineId
      ? entry?.target?.kind === 'remote' &&
        entry.target.hostId === toast.receipt.machineId &&
        entry.laneId === toast.receipt.laneId
      : activeSessionId === toast.sessionId
    if (!matches || !activeSessionId || useLayoutStore.getState().page !== null) return
    if (action === 'changes') useLayoutStore.getState().setRightPane('changes', activeSessionId)
    else document.querySelector<HTMLElement>('textarea[aria-label="Chat message"]')?.focus()
  } catch {
    // Failed navigation never changes another lane's pane or composer.
  }
}

export function LaneReceiptCard({
  toast,
  open,
}: {
  toast: Toast
  open?: () => void
}): React.JSX.Element {
  const receipt = toast.receipt
  const platform = useMachinesStore(
    (s) => s.machines.find((machine) => machine.id === receipt?.machineId)?.platform,
  )
  const facts = receipt?.facts
  const age = receipt ? Math.max(0, Math.floor((Date.now() - Date.parse(receipt.at)) / 60000)) : 0
  const title = toast.title ?? facts?.title ?? 'Untitled lane'
  const prefix = `${receipt?.machine} · `
  const label = receipt?.machineId && title.startsWith(prefix) ? title.slice(prefix.length) : title
  const stopped = facts?.outcome === 'error' || toast.kind === 'error'
  const dismiss = () => {
    useExtensionUiStore.getState().setToastsPaused('hover', false)
    useExtensionUiStore.getState().dismissToast(toast.id)
  }
  return (
    <div
      className="flex min-w-0 flex-1 flex-col border-l-[3px] rounded-l-xl"
      style={{ borderLeftColor: machineColour(receipt?.machineId) }}
    >
      <TooltipButton
        onClick={open}
        aria-label={`Open lane: ${toast.title ?? label}`}
        data-testid="toast-open"
        className="min-w-0 p-3 text-left"
      >
        <span className="text-text-secondary flex items-center justify-between text-xs">
          <span className="border-border rounded border px-1.5 py-0.5">
            {receipt?.machine ?? 'This Mac'}
            {platform
              ? ` · ${platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : platform}`
              : ''}
          </span>
          <time dateTime={receipt?.at}>{age ? `${age}m ago` : 'Just now'}</time>
        </span>
        <strong className="text-text mt-1 block truncate text-base">{label}</strong>
        {(facts?.repository || facts?.branch) && (
          <span className="text-text-tertiary block truncate text-sm">
            {[facts.repository, facts.branch && `⎇ ${facts.branch}`].filter(Boolean).join(' · ')}
          </span>
        )}
        <span
          className={
            stopped
              ? 'text-danger block truncate text-sm'
              : 'text-text-secondary block truncate text-sm'
          }
        >
          {facts?.excerpt
            ? `${stopped ? 'Stopped: ' : ''}${stripAnsi(facts.excerpt)}`
            : toast.message}
        </span>
        {facts &&
          (facts.durationMs !== null ||
            facts.files > 0 ||
            facts.tests !== null ||
            facts.artifacts > 0) && (
            <span
              className="text-text-secondary mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs"
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
          )}
      </TooltipButton>
      <div className="flex gap-3 px-3 pb-3 text-xs">
        <TooltipButton onClick={open} className="text-accent font-medium">
          Open lane
        </TooltipButton>
        {!!facts?.files && (
          <TooltipButton
            onClick={() => {
              void openReceiptAction(toast, 'changes').then(dismiss)
            }}
          >
            View changes
          </TooltipButton>
        )}
        {stopped && (
          <TooltipButton
            onClick={() => {
              void openReceiptAction(toast, 'retry').then(dismiss)
            }}
          >
            Retry
          </TooltipButton>
        )}
      </div>
    </div>
  )
}
