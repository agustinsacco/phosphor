import { useRef, useState } from 'react'
import { Button, Row, SectionTitle } from '@/components/form'
import { CheckIcon, Spinner } from '@/components/icons'
import { TooltipSummary } from '@/components/Tooltip'
import { platformName } from '@shared/platform-name'
import { usePlatform } from '@/platform/Platform'
import { EMPTY_MACHINE_UPDATE, useMachineUpdatesStore } from '@/stores/machineUpdates'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { promptChoice } from '@/stores/prompt'
import { beginMachineUpdate, controlMachineUpdate, reconnectForUpdate } from './machineUpdateRun'
import {
  deriveMachineUpdate,
  UPDATE_STEPS,
  type MachineUpdateState,
  type UpdateStep,
} from './machineUpdateState'

const STEP_LABEL: Record<UpdateStep, string> = {
  downloading: 'Download and verify',
  waiting: 'Wait for working lanes',
  paused: 'Pause lanes',
  restarting: 'Restart',
  health: 'Health check',
}

function updateLine(state: MachineUpdateState): string | undefined {
  const { run, to, label, installed, available } = state
  if (!run)
    return available
      ? `A newer version (${available}) runs on another machine.`
      : (state.can.why ?? 'Check for the newest signed release.')
  if (!run.settled) {
    if (run.step === 'downloading')
      return `Downloading and verifying${available ? ` ${available}` : ' the release'}…`
    if (run.step === 'restarting')
      return `Restarting${to ? ` on ${to}` : ''}. This usually takes under a minute.`
    if (run.step === 'health') return 'Checking that the service is back…'
    return undefined
  }
  switch (run.finish) {
    case 'updated':
      return `Updated to ${to}. Lanes continue on their next message.`
    case 'rolled-back':
      return `${to ?? 'The update'} didn’t pass its health check, so ${label} is back on ${installed ?? 'the previous version'}.`
    case 'still-working':
      return 'Lanes were still working. Nothing changed.'
    case 'cancelled':
      return 'Update cancelled. Nothing changed.'
    case 'download':
      return 'Couldn’t download and verify the update. Nothing changed.'
    case 'not-back':
      return `${label} hasn’t come back after 4 minutes. It may still be restarting.`
    case 'current':
      return 'Already up to date.'
    case 'apply':
      return `Couldn’t apply the update. ${installed ? `Still on ${installed}.` : 'Check the service connection.'}`
    case 'refused':
      return run.details?.includes('not installed from a release')
        ? 'This service is not installed from a release and cannot update itself.'
        : 'The service couldn’t start the update. Nothing changed.'
  }
}

function waitingLine(state: MachineUpdateState): string | undefined {
  const { waitingOn, deadline } = state
  if (!waitingOn || state.phase !== 'waiting') return undefined
  const { turns, subagents, routines } = waitingOn
  const time = deadline && new Date(deadline)
  const at =
    time && Number.isFinite(time.valueOf())
      ? time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : undefined
  return `Waiting for ${turns} ${turns === 1 ? 'turn' : 'turns'}, ${subagents} ${subagents === 1 ? 'sub-agent' : 'sub-agents'} and ${routines} ${routines === 1 ? 'routine' : 'routines'}. Nothing is interrupted.${at ? ` It gives up at ${at} and changes nothing.` : ''}`
}

function UpdatePipeline({ state }: { state: MachineUpdateState }) {
  const run = state.run!
  const current = UPDATE_STEPS.indexOf(run.step)
  return (
    <ol aria-label="Update steps" className="my-2 space-y-1 text-sm">
      {UPDATE_STEPS.map((step, i) => {
        if (step === 'waiting' && (run.path === 'task' || (i < current && !run.waiting)))
          return null
        const active = !run.settled && i === current
        const complete = i < current || (run.finish === 'updated' && run.settled)
        return (
          <li
            key={step}
            aria-current={active ? 'step' : undefined}
            className="flex items-center gap-2"
          >
            <span className="grid size-4 shrink-0 place-items-center" aria-hidden="true">
              {complete && <CheckIcon className="text-success size-3.5" />}
              {active && <Spinner />}
            </span>
            <span className={active ? 'text-text font-medium' : 'text-text-secondary'}>
              {STEP_LABEL[step]}
            </span>
            {active && (
              <span
                role="progressbar"
                aria-label={STEP_LABEL[step]}
                className="bg-surface-raised h-1 w-20 overflow-hidden rounded-md"
              >
                <span className="bg-accent block h-full w-1/2 motion-safe:animate-pulse" />
              </span>
            )}
          </li>
        )
      })}
    </ol>
  )
}

async function confirmUpdate(state: MachineUpdateState, working: number, product: string) {
  const release = `Install the newest signed ${product} release on ${state.label}.`
  const wait =
    state.path === 'task'
      ? `This older Host can’t wait: ${working} working ${working === 1 ? 'turn stops and is saved' : 'turns stop and are saved'}.`
      : 'The update waits for working turns, sub-agents and routines to finish.'
  return (
    (await promptChoice({
      title: `Update ${product} on ${state.label}?`,
      message: `${release}\n\n${wait} The service then restarts; every lane on this machine stops and continues on its next message. If the new version fails its health check, the previous version comes back.`,
      choices: [{ value: 'update', label: 'Update', primary: true }],
    })) === 'update'
  )
}

/** What the row shows about one machine: its derived update state, name and title. */
function useMachineUpdateView(id: string, label: string, configure: boolean, platform?: string) {
  const hosts = useRemoteLanesStore((s) => s.hosts)
  const entry = useMachineUpdatesStore((s) => s.byMachine[id] ?? EMPTY_MACHINE_UPDATE)
  const caps = usePlatform()
  const host = hosts[id]
  const owner =
    caps.localLanes &&
    host?.local === true &&
    typeof window.phosphor.onLocalMachineChanged === 'function'
  const state = deriveMachineUpdate({
    machineId: id,
    label,
    host,
    entry,
    peers: Object.values(hosts),
    configure,
    terminal: caps.terminal,
    owner,
  })
  const product = state.product === 'service' ? 'Phosphor service' : 'Phosphor Host'
  const runtime = platform || (owner ? window.phosphor.platform : undefined)
  const title = [
    product + (state.installed ? ` ${state.installed}` : ''),
    runtime && platformName(runtime),
  ]
    .filter(Boolean)
    .join(' · ')
  return { host, owner, state, product, title }
}

/** The row's one button area: Stop and Cancel while waiting, a spinner while running, else Update…. */
function UpdateActions({
  id,
  owner,
  state,
  asking,
  onUpdate,
}: {
  id: string
  owner: boolean
  state: MachineUpdateState
  asking: boolean
  onUpdate: () => void
}) {
  const running = !!state.run && !state.run.settled
  return (
    <>
      {state.can.stopTurns && (
        <Button onClick={() => void controlMachineUpdate(id, 'abort-now', owner)}>
          Stop turns and update now
        </Button>
      )}
      {state.can.cancel && (
        <Button onClick={() => void controlMachineUpdate(id, 'cancel', owner)}>
          Cancel update
        </Button>
      )}
      {state.run?.settled && state.run.finish === 'not-back' ? (
        <Button onClick={() => void reconnectForUpdate(id)}>Reconnect</Button>
      ) : running && !state.can.stopTurns ? (
        <span className="inline-flex min-w-24 justify-center" aria-hidden="true">
          <Spinner />
        </span>
      ) : (
        !running && (
          <Button className="min-w-24" disabled={asking || !state.can.start} onClick={onUpdate}>
            Update…
          </Button>
        )
      )}
    </>
  )
}

export function SoftwareUpdateRow({
  id,
  label,
  platform,
  configure,
  children,
}: {
  id: string
  label: string
  platform?: string
  configure: boolean
  children?: React.ReactNode
}) {
  const { host, owner, state, product, title } = useMachineUpdateView(
    id,
    label,
    configure,
    platform,
  )
  const [asking, setAsking] = useState(false)
  const pending = useRef(false)
  async function update() {
    if (pending.current || !state.can.start || state.path === 'none') return
    pending.current = true
    setAsking(true)
    try {
      const working =
        host?.lanes.filter((lane) => lane.activity === 'working' || lane.activity === 'needs-input')
          .length ?? 0
      if (await confirmUpdate(state, working, product)) await beginMachineUpdate(id, state.path)
    } finally {
      pending.current = false
      setAsking(false)
    }
  }
  return (
    <section aria-label="Software">
      <SectionTitle small>Software</SectionTitle>
      <Row
        title={title}
        description={
          <span role="status" className="tabular-nums">
            {waitingLine(state) ?? updateLine(state)}
          </span>
        }
      >
        <UpdateActions
          id={id}
          owner={owner}
          state={state}
          asking={asking}
          onUpdate={() => void update().catch(() => undefined)}
        />
      </Row>
      {state.run && <UpdatePipeline state={state} />}
      {state.run?.details && (
        <details key={state.run.started} className="my-2 text-sm">
          <TooltipSummary>Show details</TooltipSummary>
          <pre className="bg-surface max-h-48 overflow-auto rounded-md p-2 break-all whitespace-pre-wrap">
            {state.run.details}
          </pre>
        </details>
      )}
      {children}
    </section>
  )
}
