import { useEffect, useRef, useState } from 'react'
import type { ContextMenuItem } from '@/components/ContextMenu'
import { brainToast } from '@/features/brain/useBrain'
import { brainLaneTitle } from '@/features/brain/laneTitle'
import { StaleBrainScope } from '@/features/brain/brainScope'
import { createHostBrainScope, invokeHostBrain } from '@/features/brain/useHostBrain'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import type { HostBrainVersion } from '@shared/host-brain-request'
import { HostLaneBrainDialog } from './HostLaneBrainDialog'
import { hostLaneBrainContext } from './hostLaneBrain'
import { laneActions, type LaneActionContext, type LaneActionHandlers } from './laneActions'

type Scope = ReturnType<typeof createHostBrainScope>
type BrainContext = Pick<LaneActionContext, 'knowledge' | 'brainExclusion'>
interface Answer {
  context: BrainContext
  expected: HostBrainVersion
}

/** What one menu open learned about the lane, bound to the connection and Brain version it read. */
interface Probe {
  serial: number
  identity: string
  scope: Scope
  answer?: Answer
  failed?: boolean
}

/**
 * A Host lane's Brain entries. Nothing is read for a row until its menu opens; each open reads the
 * Host's status and this lane's state once. Queue (or Read new messages) is then a direct item,
 * written at most once per open and only while the Host, its connection and the Brain rights are
 * the ones the answer came from. Cancel, the per-lane switch and Read again stay in `Brain read…`.
 */
export function useHostLaneBrainMenu(hostId: string, laneId: string, title: string) {
  const identity = useBrainMenuIdentity(hostId, laneId)
  const probe = useLaneEligibilityProbe(hostId, laneId, title, identity)
  const [opened, setOpened] = useState<string>()

  /** The lane's whole menu, with its Brain entries as they stand for this open. */
  const items = (
    context: LaneActionContext,
    handlers: LaneActionHandlers,
    order: ContextMenuItem[],
  ): ContextMenuItem[] => {
    const fresh = probe.fresh()
    const answer = fresh?.answer
    const queue = (): void => {
      // One write per open: a second click, or one after a reopen, finds a newer serial.
      if (answer && fresh && probe.consume(fresh))
        queueHostLane(fresh.scope, hostId, laneId, title, answer.expected)
    }
    return [
      ...laneActions(
        { ...context, ...answer?.context },
        { ...handlers, ...(answer?.context.knowledge ? { knowledge: queue } : {}) },
        order,
      ),
      ...(identity
        ? [
            ...(fresh && !fresh.answer && !fresh.failed
              ? [{ label: 'Checking Brain…', disabled: true, onClick: () => {} }]
              : []),
            { label: 'Brain read…', onClick: () => setOpened(identity) },
          ]
        : []),
    ]
  }
  const dialog =
    identity && opened === identity ? (
      <HostLaneBrainDialog
        hostId={hostId}
        laneId={laneId}
        title={title}
        close={() => setOpened(undefined)}
      />
    ) : null
  return { items, dialog, onMenuOpen: probe.onMenuOpen, revision: probe.revision }
}

/** The Host, lane, connection and Brain rights a probe is read under; a string, so rows re-render only on a change. */
function useBrainMenuIdentity(hostId: string, laneId: string): string | undefined {
  return useRemoteLanesStore((state) => {
    const host = state.hosts[hostId]
    return host?.state === 'ready' &&
      host.brain &&
      host.brainAccess?.includes('read') &&
      host.brainAccess.includes('configure') &&
      window.phosphor.hostBrain
      ? JSON.stringify([
          hostId,
          laneId,
          host.connectionToken,
          [...host.brainAccess].sort().join(','),
        ])
      : undefined
  })
}

function useLaneEligibilityProbe(
  hostId: string,
  laneId: string,
  title: string,
  identity: string | undefined,
) {
  const [probe, setProbe] = useState<Probe>()
  // Read synchronously by the click handler and by the menu built in the event that opened it.
  const live = useRef({ serial: 0, identity, detach: undefined as undefined | (() => void) })
  live.current.identity = identity
  useEffect(
    () => () => {
      live.current.serial++
      live.current.detach?.()
    },
    [],
  )
  const onMenuOpen = (): void => {
    live.current.detach?.()
    live.current.detach = undefined
    const serial = ++live.current.serial
    if (!identity) return setProbe(undefined)
    const [, , token, rights] = JSON.parse(identity) as [string, string, string, string]
    const scope = createHostBrainScope(hostId, token, rights)
    live.current.detach = scope.attach()
    setProbe({ serial, identity, scope })
    const settle = (next: Partial<Probe>) => {
      if (live.current.serial === serial) setProbe({ serial, identity, scope, ...next })
    }
    readLaneEligibility(scope, hostId, laneId, title).then(
      (answer) => settle({ answer }),
      () => settle({ failed: true }),
    )
  }
  const settled = probe && (probe.answer ? 'answer' : probe.failed ? 'failed' : 'checking')
  return {
    onMenuOpen,
    /** This open's probe; one from an earlier open, or read under another grant, is ignored. */
    fresh: () =>
      probe?.serial === live.current.serial && probe.identity === identity ? probe : undefined,
    /** Claims the probe's single write, while it is still this open's and its grant still holds. */
    consume: (target: Probe): boolean => {
      if (target.serial !== live.current.serial || target.identity !== live.current.identity)
        return false
      live.current.serial++
      setProbe(undefined)
      return true
    },
    /** Rebuilds an open menu when an answer arrives or the grant it was read under changes. */
    revision: JSON.stringify([identity, probe?.serial ?? 0, settled ?? null]),
  }
}

/** The lane's direct read, if any: only Queue or Read new messages, never Cancel. */
async function readLaneEligibility(
  scope: Scope,
  hostId: string,
  laneId: string,
  title: string,
): Promise<Answer> {
  const status = await invokeHostBrain(scope, hostId, { method: 'brain:status', args: [] })
  const expected = { generation: status.generation, revision: status.revision }
  if (!status.supported || !status.prefs.enabled) return { context: {}, expected }
  const lane = await invokeHostBrain(scope, hostId, { method: 'brain:laneState', args: [laneId] })
  const context = hostLaneBrainContext(status, lane, title)
  const knowledge = context.knowledge === 'cancel' ? undefined : context.knowledge
  return { context: { ...context, knowledge }, expected }
}

/** The scope refuses before sending when the Host, its connection or the rights changed. */
function queueHostLane(
  scope: Scope,
  hostId: string,
  laneId: string,
  title: string,
  expected: HostBrainVersion,
): void {
  invokeHostBrain(scope, hostId, { method: 'brain:queue', args: [laneId], expected }).then(
    () => brainToast(`Queued ${brainLaneTitle(title)} for knowledge extraction`),
    (error: unknown) =>
      brainToast(
        error instanceof StaleBrainScope
          ? error.message
          : 'The Host did not confirm this read. Check Brain before trying again.',
        'error',
      ),
  )
}
