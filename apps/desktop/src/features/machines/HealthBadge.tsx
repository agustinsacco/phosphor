import clsx from 'clsx'
import { useRef, useState } from 'react'
import { PopupMenu } from '@/components/PopupMenu'
import { TooltipButton, tooltipProps } from '@/components/Tooltip'
import { Button } from '@/components/form'
import { CheckIcon, ChevronDownIcon, RefreshIcon, WarningIcon } from '@/components/icons'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { healthSummary, type HealthStep, type StepTone } from './healthCheck'
import { startHealthCheck, useMachineHealthStore } from './healthStore'
import { relativeTime } from './machinePresentation'
import { Spinner, StatusDot } from './MachineUi'

const BADGE: Record<StepTone, string> = {
  ok: 'text-success',
  warn: 'text-warning',
  error: 'text-danger',
  off: 'text-text-secondary',
  pending: 'text-info',
  running: 'text-text-secondary',
}

/** The page's live status: a badge that opens the health check, and a refresh. */
export function HealthBadge({
  signedIn,
  onOpenLog,
}: {
  signedIn: boolean
  onOpenLog: () => void
}): React.JSX.Element {
  const machines = useMachinesStore((s) => s.machines)
  const controlError = useMachinesStore((s) => s.error !== null)
  const now = useMachinesStore((s) => (s.nowMs || Date.now()) + s.clockOffsetMs)
  const hosts = useRemoteLanesStore((s) => s.hosts)
  const { run, running } = useMachineHealthStore()
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLDivElement>(null)
  const summary = healthSummary({ running, controlError, signedIn, machines, hosts, now, run })
  return (
    <div ref={trigger} className="relative flex items-center gap-1">
      <TooltipButton
        tooltip="Health check"
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="health-badge"
        data-tone={summary.tone}
        onClick={() => setOpen((value) => !value)}
        className="border-border hover:bg-bg-secondary flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-sm font-medium transition-colors"
      >
        {summary.tone === 'running' ? (
          <Spinner size={11} />
        ) : (
          <StatusDot tone={summary.tone} pulse={summary.tone === 'pending'} />
        )}
        <span className={BADGE[summary.tone]}>{summary.label}</span>
        <ChevronDownIcon size={10} className="text-text-tertiary" />
      </TooltipButton>
      <TooltipButton
        tooltip={running ? 'Checking…' : 'Refresh and check every machine'}
        aria-label="Refresh"
        disabled={running}
        onClick={() => void startHealthCheck()}
        className="text-text-secondary hover:text-text hover:bg-bg-secondary flex h-8 w-8 items-center justify-center rounded-sm transition-colors disabled:opacity-60"
      >
        <RefreshIcon size={13} className={running ? 'motion-safe:animate-spin' : undefined} />
      </TooltipButton>
      {open && (
        <PopupMenu
          triggerRef={trigger}
          onClose={() => setOpen(false)}
          ariaLabel="Health check"
          className="absolute right-0 top-full mt-1.5 w-[24rem] max-w-[calc(100vw-2rem)]"
        >
          <HealthPanel
            onOpenLog={() => {
              setOpen(false)
              onOpenLog()
            }}
          />
        </PopupMenu>
      )}
    </div>
  )
}

function HealthPanel({ onOpenLog }: { onOpenLog: () => void }): React.JSX.Element {
  const { run, running } = useMachineHealthStore()
  const hosts = useRemoteLanesStore((s) => s.hosts)
  const [reconnecting, setReconnecting] = useState<string | null>(null)
  const finished = run?.finishedAt
  return (
    <div role="dialog" aria-label="Health check" className="flex max-h-[70vh] flex-col">
      <div className="border-border flex items-center gap-3 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">Health check</h2>
          <p role="status" className="text-text-tertiary text-sm">
            {running
              ? 'Checking every machine…'
              : finished
                ? `Last run ${relativeTime(new Date(finished).toISOString(), Date.now())}`
                : 'Reads the control plane and every Host, without changing anything.'}
          </p>
        </div>
        <Button
          size="sm"
          variant="primary"
          disabled={running}
          onClick={() => void startHealthCheck()}
        >
          {running ? 'Checking…' : run ? 'Run again' : 'Run check'}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {!run && !running && (
          <p className="text-text-secondary px-2 py-3 text-base">
            No check has run in this window yet.
          </p>
        )}
        {run?.targets.map((target) => (
          <section key={target.id} aria-label={target.label} className="px-2 py-1.5">
            <div className="flex items-center justify-between gap-2 pb-1">
              <h3 className="text-text-tertiary font-mono text-xs font-semibold uppercase tracking-wider">
                {target.label}
              </h3>
              {target.id !== 'local' && hosts[target.id] && (
                <Button
                  size="xs"
                  tooltip="Drop and reopen this Host's connection. Open lanes resync."
                  disabled={reconnecting === target.id}
                  onClick={() => {
                    setReconnecting(target.id)
                    void window.phosphor
                      .invoke('hosts:reconnect', target.id)
                      .catch(() => undefined)
                      .finally(() => setReconnecting(null))
                  }}
                >
                  {reconnecting === target.id ? 'Reconnecting…' : 'Reconnect'}
                </Button>
              )}
            </div>
            <ul>
              {target.steps.map((step) => (
                <StepRow key={step.id} step={step} />
              ))}
            </ul>
          </section>
        ))}
      </div>
      <div className="border-border flex items-center justify-between border-t px-4 py-2.5">
        <span className="text-text-tertiary text-sm">Reads only; nothing is restarted.</span>
        <Button size="xs" onClick={onOpenLog}>
          Open debug log
        </Button>
      </div>
    </div>
  )
}

function StepRow({ step }: { step: HealthStep }): React.JSX.Element {
  return (
    <li
      data-step={step.id}
      data-tone={step.tone}
      className="flex items-center gap-2 py-1 text-base"
    >
      <span className="flex w-4 shrink-0 justify-center">
        {step.tone === 'running' ? (
          <Spinner size={11} />
        ) : step.tone === 'ok' ? (
          <CheckIcon size={12} className="text-success" />
        ) : step.tone === 'warn' || step.tone === 'error' ? (
          <WarningIcon
            size={12}
            className={step.tone === 'error' ? 'text-danger' : 'text-warning'}
          />
        ) : (
          <StatusDot tone={step.tone} />
        )}
      </span>
      <span className="w-24 shrink-0 font-medium">{step.label}</span>
      <span
        {...tooltipProps(step.tone === 'running' ? undefined : step.detail)}
        className={clsx(
          'min-w-0 flex-1 truncate',
          step.tone === 'warn' || step.tone === 'error' ? 'text-text' : 'text-text-secondary',
        )}
      >
        {step.tone === 'running' ? 'Checking…' : step.detail}
      </span>
      {step.ms !== undefined && step.tone !== 'running' && (
        <span className="text-text-tertiary font-mono text-sm tabular-nums">{step.ms} ms</span>
      )}
    </li>
  )
}
