import type { LiveSession } from '@phosphor/session-runtime/pi/session-registry'
import { bounded } from './authority'

export interface CaptureIdentity {
  sessionId: string
  sessionFile?: string
}
export interface CaptureSnapshot {
  identity: CaptureIdentity
  entries: unknown[]
}
export async function readCaptureSnapshot(
  live: LiveSession,
  expected?: CaptureIdentity,
): Promise<CaptureSnapshot> {
  const identity = async (): Promise<CaptureIdentity> => {
    const state = await live.client.request({ type: 'get_state' })
    if (!state.success || typeof state.data?.sessionId !== 'string')
      throw new Error('Brain capture identity unavailable')
    return { sessionId: state.data.sessionId, sessionFile: state.data.sessionFile }
  }
  const first = await identity()
  const response = await live.client.request({ type: 'get_entries' })
  const last = await identity()
  for (const current of [last, ...(expected ? [expected] : [])]) {
    if (current.sessionId !== first.sessionId || current.sessionFile !== first.sessionFile)
      throw new Error('Brain capture identity changed')
  }
  if (!response.success || !response.data || !Array.isArray(response.data.entries))
    throw new Error('Brain capture entries unavailable')
  const entries = response.data.entries
  bounded(entries, 1_000_000)
  if (entries.length > 4000) throw new Error('Brain capture baseline exceeds limit')
  const ids = entries.map((raw) => (raw as { id?: unknown } | null)?.id)
  if (
    ids.some((id) => typeof id !== 'string' || id.length > 200) ||
    new Set(ids).size !== ids.length
  )
    throw new Error('Brain capture entry identity unavailable')
  return { identity: first, entries }
}
