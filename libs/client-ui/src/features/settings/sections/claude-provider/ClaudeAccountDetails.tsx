import { useCallback, useEffect, useState } from 'react'
import clsx from 'clsx'
import { TooltipButton, TooltipSummary } from '@/components/Tooltip'
import type { ClaudeUsageSnapshotResult } from '@shared/models'
import { Spinner } from '@/components/icons'
import { useAsyncAction } from '@/components/useAsyncAction'
import { moveTargets, type MoveTarget } from '@/lib/claudeGateway'
import { promptChoice } from '@/stores/prompt'
import {
  usageBarClass,
  usageTextClass,
  usageUnavailableReason,
  windowResetLabel,
  windowTitle,
} from '@/lib/claudeUsage'
import type {
  ClaudeAccountLane,
  ClaudeAccountModel,
  ClaudeAccountsSource,
} from '../accounts/accountsModel'

type DetailsSource = Pick<
  ClaudeAccountsSource,
  'accounts' | 'caps' | 'usage' | 'moveLane' | 'openLane' | 'moveBlocked'
>

/**
 * An opened account row: its own usage and lanes. Usage is read only when a row
 * opens, because a live reading is a `claude -p /usage` spawn per account.
 */
export function ClaudeAccountDetails({
  account,
  source,
}: {
  account: ClaudeAccountModel
  source: DetailsSource
}): React.JSX.Element {
  // undefined while checking; null when the machine has no reading yet.
  const [state, setState] = useState<ClaudeUsageSnapshotResult | null | undefined>(undefined)
  const { usage } = source
  const read = useCallback(
    async (force: boolean): Promise<void> => {
      setState(
        await usage(account.id, force)
          // A rejected read is a failed run, never a permanent "Checking…".
          .catch((): ClaudeUsageSnapshotResult => ({ ok: false, error: 'run-failed' })),
      )
    },
    [usage, account.id],
  )
  useEffect(() => {
    void read(false)
  }, [read])

  return (
    <div className="border-border/60 mt-2.5 space-y-3 border-t pt-2.5">
      {state === undefined ? (
        <div className="text-text-secondary flex items-center gap-2 text-sm">
          <Spinner /> Checking this account&apos;s usage…
        </div>
      ) : (
        <>
          <UsageWindows state={state} />
          <TooltipButton
            onClick={() => void read(true)}
            className="text-text-secondary hover:text-text text-sm"
            tooltip="Read this account's usage from the Claude CLI again"
          >
            Check again
          </TooltipButton>
        </>
      )}
      <LaneList account={account} source={source} />
    </div>
  )
}

/** The windows, or why there are none. No reading is not zero: it never draws a meter. */
function UsageWindows({ state }: { state: ClaudeUsageSnapshotResult | null }): React.JSX.Element {
  if (state === null) return <p className="text-text-secondary text-sm">No usage reading yet.</p>
  if (!state.ok || state.snapshot.windows.length === 0)
    return (
      <p className="text-text-secondary text-sm">
        {usageUnavailableReason(state.ok ? 'no-usage' : state.error)}
      </p>
    )
  return (
    <div className="space-y-2.5">
      {state.snapshot.stale && (
        <p className="text-warning text-sm">
          Last-known usage — the CLI could not refresh it just now.
        </p>
      )}
      {state.snapshot.windows.map((window) => {
        const percent = Math.round(window.percentUsed)
        const reset = windowResetLabel(window.resetsAt)
        return (
          <div key={window.label}>
            <div className="flex items-center justify-between gap-3">
              <span className="text-base">{windowTitle(window)}</span>
              <span className={clsx('font-mono text-sm tabular-nums', usageTextClass(percent))}>
                {percent}% used{reset ? ` · ${reset}` : ''}
              </span>
            </div>
            <div className="bg-bg-secondary mt-1 h-1.5 overflow-hidden rounded-full">
              <div
                className={clsx('h-full rounded-full', usageBarClass(percent))}
                style={{ width: `${Math.min(100, percent)}%` }}
              />
            </div>
          </div>
        )
      })}
      {state.snapshot.contributing && (
        <details className="text-text-tertiary text-sm">
          <TooltipSummary className="cursor-pointer">What&apos;s contributing</TooltipSummary>
          <pre className="mt-1 max-h-52 overflow-auto whitespace-pre-wrap font-sans leading-snug">
            {state.snapshot.contributing}
          </pre>
        </details>
      )}
    </div>
  )
}

/** The lanes billing this account, each with somewhere else to go. */
function LaneList({
  account,
  source,
}: {
  account: ClaudeAccountModel
  source: DetailsSource
}): React.JSX.Element {
  const targets = moveTargets(
    source.accounts.map((target) => ({ ...target, label: target.moveLabel })),
    account.id,
  )
  const live = source.caps.lanes === 'live'
  return (
    <div>
      <div className="text-text-tertiary text-2xs pb-1 font-mono uppercase tracking-wider">
        {live ? 'Sessions on this account' : 'Lanes on this account'}
      </div>
      {account.lanes.length === 0 ? (
        <p className="text-text-tertiary text-sm">
          {live
            ? 'No live session is spending it. Closed sessions still bill it when reopened.'
            : 'No saved or running lane is bound to this account.'}
        </p>
      ) : (
        <div className="space-y-1">
          {account.lanes.map((lane) => (
            <LaneRow
              key={lane.id}
              lane={lane}
              account={account}
              targets={targets}
              source={source}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** Ask before a restart or a move: both respawn the lane, and the next turn re-reads it. */
async function confirmMove(
  lane: ClaudeAccountLane,
  target: MoveTarget,
  restart: boolean,
): Promise<boolean> {
  const label = restart ? 'Restart this lane' : `Move to ${target.label} and restart`
  const choice = await promptChoice({
    title: `${restart ? 'Restart' : 'Move'} ${lane.title}?`,
    message: `This stops and resumes the lane on ${target.label}${target.held ? ' (also held by quota)' : ''}. Work in flight may be interrupted, and the next turn re-reads the whole thread, which costs tokens. No prompt is sent.`,
    choices: [{ value: 'move', label, primary: true }],
  })
  return choice === 'move'
}

/**
 * One lane, and what you can do to it when its account is spent. A restart and
 * a move are the same operation: stop the lane and resume its session on an
 * account, because a running lane's credential is fixed when it spawns.
 */
function LaneRow({
  lane,
  account,
  targets,
  source,
}: {
  lane: ClaudeAccountLane
  account: ClaudeAccountModel
  targets: MoveTarget[]
  source: DetailsSource
}): React.JSX.Element {
  const action = useAsyncAction()
  const blocked = source.moveBlocked ?? null
  const disabled = action.busy || !lane.resumable || blocked !== null
  const go = (target: MoveTarget, restart: boolean): void =>
    void action.run(async () => {
      if (await confirmMove(lane, target, restart)) await source.moveLane(lane.id, target.id)
    })
  const self = { id: account.id, label: account.label, held: false }
  return (
    <div className="bg-surface-raised rounded-md px-2.5 py-1.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm">{lane.title}</span>
        {lane.folder && (
          <span className="text-text-tertiary text-2xs shrink-0 font-mono">{lane.folder}</span>
        )}
        {source.caps.lanes === 'saved' && (
          <span className="text-text-tertiary shrink-0 text-sm">
            {lane.active ? 'Running' : 'Stopped'}
          </span>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {source.openLane && (
          <TooltipButton
            onClick={() => source.openLane?.(lane.id)}
            className="text-text-secondary hover:text-text text-sm"
          >
            Open lane
          </TooltipButton>
        )}
        <TooltipButton
          onClick={() => go(self, true)}
          disabled={disabled}
          tooltip={blocked ?? `Restart this lane on ${account.label}`}
          className="text-text-secondary hover:text-text text-sm disabled:opacity-40"
        >
          Restart
        </TooltipButton>
        {targets.map((target) => (
          <TooltipButton
            key={target.id}
            onClick={() => go(target, false)}
            disabled={disabled}
            tooltip={blocked ?? undefined}
            className="text-accent text-sm hover:underline disabled:opacity-40"
          >
            Move to {target.label}
            {target.held ? ' (also held)' : ''}
          </TooltipButton>
        ))}
        {action.busy && <Spinner />}
      </div>
      {!lane.resumable && (
        <p className="text-text-tertiary text-2xs mt-0.5">
          Nothing saved yet — pi writes the session file when the first message is sent.
        </p>
      )}
      {action.error && <p className="text-danger text-2xs mt-0.5">{action.error}</p>}
    </div>
  )
}
