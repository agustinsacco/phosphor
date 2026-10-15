import { parseLaneReceipt, receiptSummary } from '@shared/lane-receipt'
import type { AttentionEvent } from '@shared/host-protocol'
import type { HostAttention } from '@shared/ipc'

export function createHostAttention(ports: {
  receipt?: (hostId: string, laneId: string) => Promise<unknown>
  label: (hostId: string) => string
  focused: (hostId: string, laneId: string) => boolean
  publish: (event: HostAttention) => void
  notify: (title: string, body: string, click: () => void) => void
  open: (hostId: string, laneId: string) => void
}) {
  const seen = new Set<string>()
  const pending = new Map<string, Promise<unknown>>()
  let generation = 0
  return {
    clear: () => {
      generation++
      seen.clear()
      pending.clear()
    },
    receive(hostId: string, event: AttentionEvent) {
      const key = `${hostId}/${event.id}`
      if (seen.has(key)) return
      seen.add(key)
      if (seen.size > 1600) {
        const oldest = seen.values().next().value
        if (oldest) seen.delete(oldest)
      }
      const kind = event.kind.startsWith('routine-') ? 'routine' : event.kind
      const attention: HostAttention = {
        hostId,
        laneId: event.laneId,
        kind: kind === 'finished' || kind === 'needs-input' || kind === 'failed' ? kind : 'routine',
        title: event.title ?? 'Untitled lane',
        at: event.at,
      }
      const enrich =
        event.kind === 'finished' || event.kind === 'failed' || event.kind === 'routine-finished'
      const before = generation
      const publish = (value?: unknown) => {
        if (before !== generation) return
        const parsed = parseLaneReceipt(value)
        const receipt =
          enrich &&
          parsed &&
          parsed.settledAt !== null &&
          Math.abs(parsed.settledAt - Date.parse(event.at)) <= 30_000 &&
          (event.kind === 'failed') === (parsed.outcome === 'error')
            ? parsed
            : null
        if (receipt) attention.receipt = receipt
        ports.publish(attention)
        if (!ports.focused(hostId, event.laneId))
          ports.notify(
            `${ports.label(hostId)} · ${attention.title}`,
            receipt
              ? receiptSummary(receipt)
              : attention.kind === 'failed'
                ? 'Stopped'
                : attention.kind === 'finished'
                  ? 'Done'
                  : attention.kind,
            () => ports.open(hostId, event.laneId),
          )
      }
      if (!enrich || !ports.receipt || ports.focused(hostId, event.laneId)) return publish()
      const laneKey = `${hostId}/${event.laneId}`
      let request = pending.get(laneKey)
      if (!request) {
        if (pending.size >= 1600) return publish()
        request = ports.receipt(hostId, event.laneId).catch(() => undefined)
        pending.set(laneKey, request)
        void request.finally(() => {
          if (pending.get(laneKey) === request) pending.delete(laneKey)
        })
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      void Promise.race([
        request,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), 2000)
        }),
      ])
        .then(publish)
        .finally(() => clearTimeout(timer))
    },
  }
}

/** Only the connection that began this read may supply the receipt. */
export async function readHostReceipt(
  connectionFor: (hostId: string) =>
    | {
        snapshot(): {
          state: string
          capabilities: readonly string[]
          lanes: readonly { laneId: string }[]
        }
        call(method: string, params: unknown): Promise<{ ok: true; data?: unknown } | { ok: false }>
      }
    | undefined,
  hostId: string,
  laneId: string,
): Promise<unknown> {
  const connection = connectionFor(hostId)
  if (!connection?.snapshot().capabilities.includes('sessions.read')) return undefined
  const data = await connection.call('lane.receipt', { laneId })
  const view = connection.snapshot()
  if (
    connectionFor(hostId) !== connection ||
    view.state !== 'ready' ||
    !view.capabilities.includes('sessions.read') ||
    !view.lanes.some((lane) => lane.laneId === laneId)
  )
    return undefined
  return data.ok ? data.data : undefined
}
