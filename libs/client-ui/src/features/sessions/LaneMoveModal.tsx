import { useEffect, useMemo, useRef, useState } from 'react'
import { errorText } from '@shared/errors'
import type { LaneMovePlan, LaneMoveResult, LaneMoveTarget } from '@shared/lane-move'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
import { Button } from '@/components/form'
import { useLaneMoveStore, type LaneMoveDraft } from '@/stores/laneMove'
import { machineLabel, navigateToLane, useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useWorkspacesStore } from '@/stores/workspaces'
import {
  formatMoveBytes,
  moveMachines,
  planSummary,
  sourceHint,
  type MoveMachine,
} from './laneMove'

type Check =
  | { state: 'idle' | 'checking' }
  | { state: 'ready'; plan: LaneMovePlan }
  | { state: 'failed'; message: string }
type Done = Exclude<LaneMoveResult, { blockers: string[] }>

const selectClass =
  'border-border bg-surface text-text w-full rounded-lg border px-2.5 py-1.5 text-base outline-none'

/** Renders the "Move to…" dialog for whichever lane asked for it. */
export function LaneMoveHost(): React.JSX.Element | null {
  const draft = useLaneMoveStore((s) => s.draft)
  const close = useLaneMoveStore((s) => s.close)
  return draft ? (
    <LaneMoveModal key={JSON.stringify(draft.source)} draft={draft} onClose={close} />
  ) : null
}

/** A local copy carries its pin and marker here; a Host applies its own. */
function keepMarks(draft: LaneMoveDraft, result: Done) {
  if (!('sessionPath' in result)) return
  const sessions = useSessionsStore.getState()
  if (draft.marks.pinned && !sessions.pinned.includes(result.sessionPath))
    sessions.togglePin(result.sessionPath)
  if (draft.marks.marker !== null) sessions.setLaneMarker(result.sessionPath, draft.marks.marker)
  void sessions.refreshDisk(result.workspace)
}

async function openMoved(result: Done): Promise<void> {
  if ('laneId' in result) {
    await navigateToLane({ hostId: result.machine, laneId: result.laneId })
    return
  }
  const sessions = useSessionsStore.getState()
  await sessions.refreshDisk(result.workspace)
  const meta = Object.values(useSessionsStore.getState().disk)
    .flat()
    .find((m) => m.path === result.sessionPath)
  if (!meta) throw new Error('The copy is saved, but this window has not listed it yet.')
  await navigateToLane({ sessionId: await sessions.openDiskSession(result.workspace, meta) })
}

/** Ask the target what a move would do whenever the choice changes; older answers are dropped. */
function useMovePlan(
  draft: LaneMoveDraft,
  target: LaneMoveTarget | undefined,
  unavailable?: string,
) {
  const [check, setCheck] = useState<Check>({ state: 'idle' })
  const run = useRef(0)
  useEffect(() => {
    const id = ++run.current
    if (!target || unavailable) {
      setCheck({ state: 'idle' })
      return
    }
    setCheck({ state: 'checking' })
    void window.phosphor
      .invoke('hosts:laneMovePlan', { source: draft.source, target, marks: draft.marks })
      .then(
        (plan) => {
          if (run.current === id) setCheck({ state: 'ready', plan })
        },
        (cause: unknown) => {
          if (run.current === id) setCheck({ state: 'failed', message: errorText(cause) })
        },
      )
  }, [target, draft, unavailable])
  return check
}

function TargetFields(props: {
  machines: MoveMachine[]
  machine: string
  workspace: string
  disabled: boolean
  onMachine: (machine: string) => void
  onWorkspace: (key: string) => void
}): React.JSX.Element {
  const chosen = props.machines.find((m) => m.machine === props.machine)
  return (
    <>
      <label className="block space-y-1">
        <span className="text-text-secondary">Machine</span>
        <select
          aria-label="Machine"
          className={selectClass}
          value={props.machine}
          disabled={props.disabled}
          onChange={(e) => props.onMachine(e.target.value)}
        >
          {props.machines.map((m) => (
            <option key={m.machine} value={m.machine} disabled={!!m.disabled}>
              {m.disabled ? `${m.label} · ${m.disabled}` : m.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1">
        <span className="text-text-secondary">Workspace</span>
        <select
          aria-label="Workspace"
          className={selectClass}
          value={props.workspace}
          disabled={props.disabled || !!chosen?.disabled}
          onChange={(e) => props.onWorkspace(e.target.value)}
        >
          <option value="">Choose a workspace…</option>
          {chosen?.workspaces.map((w) => (
            <option key={w.key} value={w.key}>
              {w.label}
            </option>
          ))}
        </select>
      </label>
    </>
  )
}

function PlanView({ check }: { check: Check }): React.JSX.Element | null {
  if (check.state === 'checking') return <p className="text-text-secondary">Checking…</p>
  if (check.state === 'failed') return <p className="text-danger">{check.message}</p>
  if (check.state !== 'ready') return null
  const { plan } = check
  if (plan.blockers.length)
    return (
      <ul className="text-danger list-disc space-y-1 pl-5" aria-label="Why this lane cannot move">
        {plan.blockers.map((b) => (
          <li key={b}>{b}</li>
        ))}
      </ul>
    )
  return (
    <p>
      {planSummary(plan)} {formatMoveBytes(plan.bytes)} to copy. The original stays where it is.
    </p>
  )
}

function LaneMoveModal({
  draft,
  onClose,
}: {
  draft: LaneMoveDraft
  onClose: () => void
}): React.JSX.Element {
  const hosts = useRemoteLanesStore((s) => s.hosts)
  const recents = useWorkspacesStore((s) => s.recents)
  const sandboxes = useWorkspacesStore((s) => s.sandboxes)
  const machines = useMemo(
    () => moveMachines({ hosts, labelOf: machineLabel, recents, sandboxes }),
    [hosts, recents, sandboxes],
  )
  const unavailable = sourceHint(hosts, draft.source)
  const [machine, setMachine] = useState(
    () => machines.find((m) => !m.disabled)?.machine ?? 'local',
  )
  const [workspace, setWorkspace] = useState('')
  const chosen = machines.find((m) => m.machine === machine)
  const picked = chosen?.workspaces.find((w) => w.key === workspace)
  const check = useMovePlan(draft, picked?.target, unavailable)
  const [moving, setMoving] = useState(false)
  const [done, setDone] = useState<Done | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function move(target: LaneMoveTarget): Promise<void> {
    setMoving(true)
    setError(null)
    try {
      const result = await window.phosphor.invoke('hosts:laneMove', {
        source: draft.source,
        target,
        marks: draft.marks,
      })
      if ('blockers' in result) setError(result.blockers.join(' '))
      else {
        keepMarks(draft, result)
        setDone(result)
      }
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setMoving(false)
    }
  }
  const blocked = check.state !== 'ready' || check.plan.blockers.length > 0
  const open = () => {
    if (done) void openMoved(done).then(onClose, (cause: unknown) => setError(errorText(cause)))
  }
  const start = () => {
    if (picked) void move(picked.target)
  }
  const footer = done ? (
    <>
      <Button onClick={onClose}>Done</Button>
      <Button variant="primary" onClick={open}>
        Open
      </Button>
    </>
  ) : (
    <>
      <Button onClick={onClose} disabled={moving}>
        Cancel
      </Button>
      <Button variant="primary" onClick={start} disabled={moving || blocked}>
        {moving ? 'Moving…' : 'Move'}
      </Button>
    </>
  )
  return (
    // A move in flight finishes either way; the dialog stays to say how it ended.
    <ModalOverlay onClose={onClose} closeOnBackdrop={!moving} closeOnEscape={!moving}>
      <ModalPanel
        width={460}
        title="Move lane"
        subtitle={<span className="block truncate">{draft.title}</span>}
        footer={footer}
      >
        <div className="space-y-3 px-4 py-3 text-base">
          {done ? (
            <p>
              Moved to {chosen?.label} · {picked?.label}. The original lane is unchanged.
            </p>
          ) : unavailable ? (
            <p className="text-text-secondary">{unavailable}</p>
          ) : (
            <>
              <TargetFields
                machines={machines}
                machine={machine}
                workspace={workspace}
                disabled={moving}
                onMachine={(next) => {
                  setMachine(next)
                  setWorkspace('')
                }}
                onWorkspace={setWorkspace}
              />
              <PlanView check={check} />
            </>
          )}
          {error && <p className="text-danger">{error}</p>}
        </div>
      </ModalPanel>
    </ModalOverlay>
  )
}
