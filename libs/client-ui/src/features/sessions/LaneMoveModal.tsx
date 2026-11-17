import { useEffect, useMemo, useRef, useState } from 'react'
import { errorText } from '@shared/errors'
import type { LaneMovePlan, LaneMoveResult, LaneMoveTarget } from '@shared/lane-move'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
import { Button } from '@/components/form'
import { useAwaitableNavigate } from '@/navigation/Navigation'
import { usePlatform } from '@/platform/Platform'
import { useLaneMoveStore, type LaneMoveDraft } from '@/stores/laneMove'
import { machineLabel, navigateToLane, useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useWorkspacesStore } from '@/stores/workspaces'
import {
  MEMORY_RELAY_NOTE,
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

/**
 * A Host copy opens through navigation, which both shells route (Desktop's
 * resolves once the lane is open); a This Mac copy through its file.
 */
async function openMoved(
  result: Done,
  navigate: ReturnType<typeof useAwaitableNavigate>,
): Promise<void> {
  if ('laneId' in result) {
    await navigate({ to: 'lane', lane: { hostId: result.machine, laneId: result.laneId } })
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

/**
 * Ask the target what a move would do whenever the choice changes; older
 * answers are dropped. Each check needs its own acknowledgement, so a recheck
 * (after a failed Move, say) clears it.
 */
function useMovePlan(
  draft: LaneMoveDraft,
  target: LaneMoveTarget | undefined,
  unavailable?: string,
) {
  const [check, setCheck] = useState<Check>({ state: 'idle' })
  const [accepted, setAccepted] = useState(false)
  const run = useRef(0)
  const [attempt, setAttempt] = useState(0)
  const machine = target?.machine
  const workspace = target && 'workspace' in target ? target.workspace : undefined
  const repositoryId = target && 'repositoryId' in target ? target.repositoryId : undefined
  useEffect(() => {
    const id = ++run.current
    setAccepted(false)
    if (!machine || (!workspace && !repositoryId) || unavailable) {
      setCheck({ state: 'idle' })
      return
    }
    const target: LaneMoveTarget = workspace
      ? { machine: 'local', workspace }
      : { machine, repositoryId: repositoryId! }
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
    return () => {
      run.current++
    }
  }, [machine, workspace, repositoryId, draft, unavailable, attempt])
  return { check, accepted, setAccepted, recheck: () => setAttempt((n) => n + 1) }
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

function PlanView({
  check,
  note,
  accepted,
  onAccept,
  retry,
}: {
  check: Check
  /** How the bytes travel, when that is worth saying. */
  note: string | undefined
  accepted: boolean
  onAccept: (accepted: boolean) => void
  retry: () => void
}): React.JSX.Element | null {
  if (check.state === 'checking') return <p className="text-text-secondary">Checking…</p>
  if (check.state === 'failed')
    return (
      <div>
        <p className="text-danger">{check.message}</p>
        <Button onClick={retry}>Retry check</Button>
      </div>
    )
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
    <div className="space-y-3">
      <p>
        {planSummary(plan)} {formatMoveBytes(plan.bytes)} to copy. The original stays where it is.
      </p>
      {note && <p className="text-text-secondary">{note}</p>}
      <label className="flex items-start gap-2">
        <input type="checkbox" checked={accepted} onChange={(e) => onAccept(e.target.checked)} />
        <span>
          I understand this uses the target’s skills, extensions, context files, MCP setup and
          account. They aren’t copied and may differ.
        </span>
      </label>
    </div>
  )
}

/**
 * Runs the Move and opens its copy. `onFailed` runs when a Move is refused or
 * throws: the plan it was checked against is stale.
 */
function useMoveExecution(draft: LaneMoveDraft, onClose: () => void, onFailed: () => void) {
  const navigate = useAwaitableNavigate()
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
      if ('blockers' in result) {
        setError(result.blockers.join(' '))
        onFailed()
      } else {
        keepMarks(draft, result)
        setDone(result)
      }
    } catch (cause) {
      setError(errorText(cause))
      onFailed()
    } finally {
      setMoving(false)
    }
  }
  /** Opens the copy, then closes the dialog; a failure to open stays in the dialog. */
  const open = () => {
    if (done)
      void openMoved(done, navigate).then(onClose, (cause: unknown) => setError(errorText(cause)))
  }
  return { moving, done, error, move, open }
}

function useMoveMachines() {
  const hosts = useRemoteLanesStore((s) => s.hosts)
  const recents = useWorkspacesStore((s) => s.recents)
  const sandboxes = useWorkspacesStore((s) => s.sandboxes)
  const { localLanes } = usePlatform()
  const machines = useMemo(
    () => moveMachines({ hosts, labelOf: machineLabel, recents, sandboxes, localLanes }),
    [hosts, recents, sandboxes, localLanes],
  )
  return { hosts, machines }
}

function MoveFooter({
  done,
  moving,
  blocked,
  onClose,
  onOpen,
  onStart,
}: {
  done: boolean
  moving: boolean
  blocked: boolean
  onClose: () => void
  onOpen: () => void
  onStart: () => void
}) {
  return done ? (
    <>
      <Button onClick={onClose}>Done</Button>
      <Button variant="primary" onClick={onOpen}>
        Open
      </Button>
    </>
  ) : (
    <>
      <Button onClick={onClose} disabled={moving}>
        Cancel
      </Button>
      <Button variant="primary" onClick={onStart} disabled={moving || blocked}>
        {moving ? 'Moving…' : 'Move'}
      </Button>
    </>
  )
}

function LaneMoveModal({
  draft,
  onClose,
}: {
  draft: LaneMoveDraft
  onClose: () => void
}): React.JSX.Element {
  const { hosts, machines } = useMoveMachines()
  // Desktop stages the bundle in a private temp file; the browser holds it in memory and says so.
  const { nativeFiles } = usePlatform()
  const unavailable = sourceHint(hosts, draft.source)
  // This Mac comes first where it is offered, so Desktop's fallback stays This Mac.
  const [machine, setMachine] = useState(
    () => (machines.find((m) => !m.disabled) ?? machines[0])?.machine ?? '',
  )
  const [workspace, setWorkspace] = useState('')
  const chosen = machines.find((m) => m.machine === machine)
  const picked = chosen?.workspaces.find((w) => w.key === workspace)
  const { check, accepted, setAccepted, recheck } = useMovePlan(draft, picked?.target, unavailable)
  const { moving, done, error, move, open } = useMoveExecution(draft, onClose, recheck)
  const blocked = check.state !== 'ready' || check.plan.blockers.length > 0 || !accepted
  // A refusal the fresh check lists too is shown once, in the list.
  const listed = check.state === 'ready' && !!error && check.plan.blockers.includes(error)
  const start = () => {
    if (picked) void move(picked.target)
  }
  const footer = (
    <MoveFooter
      done={!!done}
      moving={moving}
      blocked={blocked}
      onClose={onClose}
      onOpen={open}
      onStart={start}
    />
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
              <PlanView
                check={check}
                note={picked && !nativeFiles ? MEMORY_RELAY_NOTE : undefined}
                retry={recheck}
                accepted={accepted}
                onAccept={setAccepted}
              />
            </>
          )}
          {error && !listed && <p className="text-danger">{error}</p>}
        </div>
      </ModalPanel>
    </ModalOverlay>
  )
}
