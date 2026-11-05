import { parseLaneReceipt, type LaneReceipt } from '@phosphor/shared/lane-receipt'
import type { AttentionEvent } from '@phosphor/shared/host-protocol'
import type { HostAttention } from '@phosphor/shared/ipc'

/** Only a settled run or a finished routine has a receipt worth waiting for. */
export function receiptExpected(event: AttentionEvent): boolean {
  return event.kind === 'finished' || event.kind === 'failed' || event.kind === 'routine-finished'
}

export function makeAttention(hostId: string, event: AttentionEvent): HostAttention {
  const kind = event.kind.startsWith('routine-') ? 'routine' : event.kind
  return {
    hostId,
    laneId: event.laneId,
    kind: kind === 'finished' || kind === 'needs-input' || kind === 'failed' ? kind : 'routine',
    title: event.title ?? 'Untitled lane',
    at: event.at,
  }
}

/** The receipt of the run this event announces: settled within 30s of it, with a matching outcome. */
export function receiptForEvent(event: AttentionEvent, value: unknown): LaneReceipt | null {
  const parsed = parseLaneReceipt(value)
  return receiptExpected(event) &&
    parsed &&
    parsed.settledAt !== null &&
    Math.abs(parsed.settledAt - Date.parse(event.at)) <= 30_000 &&
    (event.kind === 'failed') === (parsed.outcome === 'error')
    ? parsed
    : null
}

/** A receipt read that has not answered in two seconds is not waited for. */
export function receiptWithin(request: Promise<unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    request,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), 2000)
    }),
  ]).finally(() => clearTimeout(timer))
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
