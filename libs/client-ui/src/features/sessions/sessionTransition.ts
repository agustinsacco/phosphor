import { create } from 'zustand'
import type { AgentMessage, ImageContent, PiEvent } from '@shared/rpc'
import type { ArtifactSnapshot } from '@shared/artifacts'
import { ipcErrorText } from '@shared/errors'
import { parseSwarmStatus, SWARM_STATUS_KEY } from '@phosphor/pi-extensions/swarm'
import { bootstrapSession, useSessionsStore } from '@/stores/sessions'
import { useChatStore } from '@/stores/chat'
import { useArtifactsStore } from '@/stores/artifacts'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useChatUiStore } from '@/features/chat/uiState'
import { piCall, rehydrateRunningTranscript, rehydrateTranscript } from '@/lib/rpc'
import { requestSwarm } from '@/lib/swarm'
import { drop } from '@/stores/keyedSlice'

type Restore = () => Promise<void>
interface Transition {
  busy: boolean
  retry?: Restore
}
export const useSessionTransition = create<{ bySession: Record<string, Transition> }>(() => ({
  bySession: {},
}))
const queue = new Map<string, Promise<void>>()
/**
 * Every event of a lane main already ran when this window opened it, from the moment its push
 * handler attached until its history has loaded: a running turn's history keeps the events pi's
 * messages do not hold yet.
 */
const sinceAttach = new Map<string, { events: PiEvent[]; stop(): void }>()

function recordSinceAttach(id: string): void {
  if (sinceAttach.has(id)) return
  const events: PiEvent[] = []
  const stop = window.phosphor.onSessionPush(id, (push) => {
    if (push.kind === 'event') events.push(push.event)
  })
  sinceAttach.set(id, { events, stop })
}
function stopRecording(id: string): void {
  sinceAttach.get(id)?.stop()
  sinceAttach.delete(id)
}

function setTransition(id: string, state?: Transition): void {
  useSessionTransition.setState((s) => ({
    bySession: state ? { ...s.bySession, [id]: state } : drop(s.bySession, id),
  }))
}
export function forgetSessionTransition(id: string): void {
  setTransition(id)
  stopRecording(id)
}
export function sessionTransitionPending(id: string): boolean {
  return (
    !!useSessionTransition.getState().bySession[id] ||
    !!useChatStore.getState().sessions[id]?.resuming
  )
}

/** Retry only reconciliation: a successful fork must never be issued twice. */
async function recover(id: string, restore: Restore): Promise<void> {
  if (!useSessionsStore.getState().live[id]) return setTransition(id)
  setTransition(id, { busy: true })
  useChatStore.getState().setError(id, null)
  try {
    await restore()
    setTransition(id)
  } catch (error) {
    if (!useSessionsStore.getState().live[id] || !useSessionTransition.getState().bySession[id])
      return setTransition(id)
    useChatStore.getState().setError(id, ipcErrorText(error))
    setTransition(id, {
      busy: false,
      retry: async () => {
        if (!useSessionTransition.getState().bySession[id]?.busy) await recover(id, restore)
      },
    })
  } finally {
    useChatStore.getState().doneResuming(id)
  }
}

/** One queue for Clone and Rewind; controls lock before the first await. */
function transition(id: string, mutate: () => Promise<Restore | undefined>): Promise<void> {
  if (useSessionTransition.getState().bySession[id]?.retry) return Promise.resolve()
  setTransition(id, { busy: true })
  const run = (queue.get(id) ?? Promise.resolve()).then(async () => {
    if (!useSessionsStore.getState().live[id]) return setTransition(id)
    if (useSessionTransition.getState().bySession[id]?.retry) return
    setTransition(id, { busy: true })
    try {
      const restore = await mutate()
      if (restore) await recover(id, restore)
      else setTransition(id)
    } catch (error) {
      useChatStore.getState().setError(id, ipcErrorText(error))
      setTransition(id)
    }
  })
  queue.set(id, run)
  void run.then(() => {
    if (queue.get(id) === run) queue.delete(id)
  })
  return run
}

/**
 * Used by resume, closed clones and live branch changes, including recovery. `alreadyLive`: main
 * already ran the lane, which may be mid-turn. Call it in the task that attached the lane's push
 * handler, before any await, so the recording a running turn's history needs misses no event.
 */
export function restoreSession(id: string, alreadyLive = false): Promise<void> {
  if (alreadyLive) recordSinceAttach(id)
  const restore = async () => {
    // A retry records again from here: a load that failed keeps nothing it recorded.
    if (alreadyLive) recordSinceAttach(id)
    try {
      await restoreBranch(id, undefined, alreadyLive)
    } finally {
      stopRecording(id)
    }
  }
  // Nor does an open that never loads: the lane closed, or it already waits on Retry.
  return transition(id, async () => restore).finally(() => stopRecording(id))
}

async function restoreBranch(
  id: string,
  afterIdentity?: Restore,
  alreadyLive = false,
): Promise<void> {
  if (!(await bootstrapSession(id, { fresh: true })))
    throw new Error('Could not refresh session identity. Retry loading the session.')
  if (!useSessionsStore.getState().live[id] || !useSessionTransition.getState().bySession[id])
    return
  await afterIdentity?.()
  const file = useSessionsStore.getState().live[id]?.diskPath
  if (!file) throw new Error('Session identity is unavailable. Retry loading the session.')
  const chat = useChatStore.getState().sessions[id]
  const busy =
    chat?.isStreaming || chat?.isCompacting || chat?.meta?.isStreaming || chat?.meta?.isCompacting
  if (busy && !alreadyLive)
    throw new Error('Wait for this turn to finish, then retry loading the session.')
  // A lane main runs mid-turn loads beside its live events; any other load must hold still.
  const running = busy && alreadyLive
  const artifactsBefore = useArtifactsStore.getState().bySession[id]
  const [messages, snapshots] = await Promise.all([
    running
      ? rehydrateRunningTranscript(id, sinceAttach.get(id)?.events ?? [])
      : rehydrateTranscript(id, true),
    window.phosphor.invoke('artifacts:forSession', file),
  ])
  const current = useChatStore.getState().sessions[id]
  if (
    !current ||
    !useSessionsStore.getState().live[id] ||
    !useSessionTransition.getState().bySession[id]
  )
    return
  if (!running && useArtifactsStore.getState().bySession[id] !== artifactsBefore)
    throw new Error('Artifacts changed while loading. Retry when the turn finishes.')
  if (!messages) throw new Error(current.error ?? 'Could not load session history.')
  if (running) mergeArtifacts(id, messages, snapshots ?? [])
  else replaceArtifacts(id, messages, snapshots ?? [])
}

/** A running lane's artifacts: the stored ones join those it made while its history loaded. */
function mergeArtifacts(id: string, messages: AgentMessage[], snapshots: ArtifactSnapshot[]): void {
  const artifacts = useArtifactsStore.getState()
  if (snapshots.length) artifacts.hydrate(id, snapshots)
  else artifacts.ingestFromHistory(id, messages)
}

function replaceArtifacts(
  id: string,
  messages: AgentMessage[],
  snapshots: ArtifactSnapshot[],
): void {
  // Branch identity changed under the same renderer handle: merging would retain
  // artifacts and versions from the discarded future, including their selection.
  const artifacts = useArtifactsStore.getState()
  artifacts.remove(id)
  if (snapshots.length) artifacts.hydrate(id, snapshots)
  else artifacts.ingestFromHistory(id, messages)
}

export function changeSessionBranch(
  id: string,
  command: { type: 'clone' } | { type: 'fork'; entryId: string },
  images?: ImageContent[],
): Promise<void> {
  return transition(id, async () => {
    const chat = useChatStore.getState().sessions[id]
    if (chat?.isStreaming || chat?.isCompacting || chat?.promptSentAt != null)
      throw new Error('Wait for this turn to finish before cloning or rewinding.')
    const before = useSessionsStore.getState().live[id]?.diskPath
    const swarm = parseSwarmStatus(useExtensionUiStore.getState().statuses[id]?.[SWARM_STATUS_KEY])
    const result = await piCall(id, command)
    if (!result) return
    if (result.cancelled)
      throw new Error(
        `${command.type === 'fork' ? 'Rewind' : 'Clone'} was cancelled by an extension.`,
      )
    let policyRestored = false
    let recorded = false
    return async () => {
      // Record as soon as bootstrap publishes the new file, not after its slower
      // catalogue reads. A retry observes the same captured source and result.
      const record = (): void => {
        const after = useSessionsStore.getState().live[id]?.diskPath
        if (!recorded && command.type === 'fork' && before && after && after !== before) {
          recorded = true
          useSessionsStore.getState().recordRewind(before, after)
        }
      }
      const unsubscribe = useSessionsStore.subscribe(record)
      try {
        await restoreBranch(id, async () => {
          record()
          if (!policyRestored && swarm) await requestSwarm(id, swarm.requested)
          policyRestored = true
          const file = useSessionsStore.getState().live[id]?.diskPath
          if (command.type === 'clone' && file)
            await window.phosphor.invoke('sessions:forkClaudeLedger', file)
        })
        if (command.type === 'fork' && ('text' in result || images?.length))
          useChatUiStore.getState().setPrefill(id, 'text' in result ? result.text : '', images)
      } finally {
        unsubscribe()
      }
    }
  })
}
