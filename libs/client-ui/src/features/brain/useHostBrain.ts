import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { brainClientMayInvoke, type HostBrainRequest } from '@phosphor/shared/host-brain-request'
import type { HostBrainMap, HostBrainMethod, HostBrainStatus } from '@phosphor/shared/host-brain'
import type { BrainAccess } from '@phosphor/shared/brain-access'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { createBrainScope, StaleBrainScope } from './brainScope'

export const NO_ACCESS: readonly BrainAccess[] = []

export function useHostBrainSelection(hostId: string | undefined) {
  const host = useRemoteLanesStore((s) => (hostId ? s.hosts[hostId] : undefined))
  const access = host?.brainAccess ?? NO_ACCESS
  const token = host?.connectionToken
  const rights = [...access].sort().join(',')
  const state = !hostId
    ? 'choose'
    : !host || host.state === 'connecting' || host.state === 'reconnecting'
      ? 'connecting'
      : host.state === 'signed-out'
        ? 'unauthorized'
        : host.state !== 'ready'
          ? 'unavailable'
          : !host.brain
            ? 'unsupported'
            : !access.includes('read')
              ? 'unauthorized'
              : !window.phosphor.hostBrain
                ? 'unavailable'
                : 'ready'
  const supported = host?.state === 'ready' && host.brain === true && !!window.phosphor?.hostBrain
  return {
    state,
    access,
    token,
    supported,
    key: JSON.stringify([hostId, token, rights, state]),
  } as const
}

export const HOST_BRAIN_HINT = {
  choose: 'Choose a Host to view its Brain.',
  connecting: 'Connecting to this Host…',
  unavailable: 'Brain is unavailable on this Host right now.',
  unsupported: 'This Host does not support Brain.',
  unauthorized: 'You do not have access to this Host’s Brain.',
}

/** A Host Brain scope for this connection: live only while the Host, connection and rights stay the same. */
export function createHostBrainScope(hostId: string, connectionToken: string, rights: string) {
  return createBrainScope({ hostId, connectionToken }, () => {
    const view = useRemoteLanesStore.getState().hosts[hostId]
    return (
      view?.state === 'ready' &&
      view.brain === true &&
      view.connectionToken === connectionToken &&
      [...(view.brainAccess ?? [])].sort().join(',') === rights
    )
  })
}

/** One call through `scope`, refused unless this client may still invoke `request` on that Host. */
export function invokeHostBrain<K extends HostBrainMethod>(
  scope: ReturnType<typeof createBrainScope>,
  hostId: string,
  request: HostBrainRequest<K>,
): Promise<HostBrainMap[K]['result']> {
  return scope.run((target) => {
    const bridge = window.phosphor.hostBrain
    const host = useRemoteLanesStore.getState().hosts[hostId]
    if (
      !bridge ||
      !brainClientMayInvoke(
        request.method,
        host?.brainAccess ?? NO_ACCESS,
        host?.capabilities ?? [],
      )
    )
      throw new StaleBrainScope()
    return bridge.invoke<K>(target, request)
  })
}

/** The parent key changes for every selection/connection/rights change. No Host data is cached. */
export function useHostBrain(
  hostId: string,
  connectionToken: string,
  access: readonly BrainAccess[],
) {
  const rights = [...access].sort().join(',')
  const scope = useMemo(
    () => createHostBrainScope(hostId, connectionToken, rights),
    [hostId, connectionToken, rights],
  )
  useLayoutEffect(scope.attach, [scope])
  const [status, setStatus] = useState<HostBrainStatus | null>(null)
  const [error, setError] = useState('')
  const ports = useMemo(() => ({ pending: null as null | (() => boolean) }), [scope])
  const invoke = useCallback(
    <K extends HostBrainMethod>(request: HostBrainRequest<K>): Promise<HostBrainMap[K]['result']> =>
      invokeHostBrain(scope, hostId, request),
    [scope, hostId],
  )
  const refresh = useCallback(async () => {
    if (ports.pending?.()) return
    const pending = scope.capture()
    ports.pending = pending
    try {
      const next = await invoke<'brain:status'>({ method: 'brain:status', args: [] })
      scope.changeGeneration(next.generation)
      setStatus(next)
      setError('')
    } catch (cause) {
      if (cause instanceof StaleBrainScope) return
      // An error may be permission loss; do not leave previously admitted content visible.
      scope.invalidate()
      setStatus(null)
      setError('The Host did not provide Brain status.')
    } finally {
      if (ports.pending === pending) ports.pending = null
    }
  }, [scope, invoke, ports])
  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh()
    }, 3000)
    return () => window.clearInterval(timer)
  }, [refresh])
  const view = useMemo(() => {
    const current = scope.capture()
    return {
      capture: () => current,
      invoke: <K extends HostBrainMethod>(request: HostBrainRequest<K>) =>
        current() ? invoke<K>(request) : Promise.reject(new StaleBrainScope()),
    }
  }, [scope, invoke, status?.generation])
  return { ...view, status, error, refresh, access, hostId }
}

export type HostBrainSurface = ReturnType<typeof useHostBrain>

/** Whether this client should offer `method` on the Host now: its Brain rights and capabilities. */
export function useHostBrainOffers(hostId: string, method: HostBrainMethod): boolean {
  const access = useRemoteLanesStore((s) => s.hosts[hostId]?.brainAccess ?? NO_ACCESS)
  const capabilities = useRemoteLanesStore((s) => s.hosts[hostId]?.capabilities)
  return brainClientMayInvoke(method, access, capabilities ?? [])
}
export type ReadyBrainSurface = HostBrainSurface & { status: HostBrainStatus }

export function useBrainRequest<K extends HostBrainMethod>(
  brain: HostBrainSurface,
  request: HostBrainRequest<K> | null,
) {
  const { invoke, status } = brain
  const [attempt, setAttempt] = useState(0)
  const [reply, setReply] = useState<{ key: string; data?: HostBrainMap[K]['result'] }>()
  const key = JSON.stringify([request, status?.generation, status?.revision])
  useEffect(() => {
    if (!request) return undefined
    let active = true
    void invoke<K>(request).then(
      (data) => {
        if (active) setReply({ key, data })
      },
      () => {
        if (active) setReply({ key })
      },
    )
    return () => {
      active = false
    }
    // The serialized key includes the full bounded request, generation and revision.
  }, [invoke, key, attempt])
  return {
    data: reply?.key === key ? reply.data : undefined,
    error: reply?.key === key && reply.data === undefined,
    retry: useCallback(() => setAttempt((n) => n + 1), []),
  }
}
