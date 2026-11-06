import type { BrainCapture } from '@phosphor/shared/brain'
import type { LiveSession } from '@phosphor/session-runtime/pi/session-registry'
import { extractText } from '@phosphor/session-runtime/pi/session-content'
import type { PiEvent } from '@phosphor/shared/rpc'
import type { DesktopMemoryClient } from './memory-client'
import { bounded, laneAuthority } from './authority'

interface Entry {
  type?: string
  id?: string
  parentId?: string | null
  timestamp?: string
  message?: { role?: string; content?: unknown; customType?: unknown; source?: unknown }
}
export function newUserCaptures(
  entries: unknown[],
  seen: Set<string>,
  authority: { scope: string; branch: string },
  sessionId: string,
): BrainCapture[] {
  bounded(entries, 1_000_000)
  if (entries.length > 4000) throw new Error('Brain capture entry budget exceeded')
  const known = new Set(seen)
  const result: BrainCapture[] = []
  for (const raw of entries) {
    const entry = raw as Entry | null
    if (!entry || typeof entry.id !== 'string' || entry.id.length > 200)
      throw new Error('Ambiguous Brain entry identity')
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    if (
      entry.parentId !== null &&
      (typeof entry.parentId !== 'string' || !known.has(entry.parentId))
    )
      continue
    known.add(entry.id)
    const message = entry.message
    if (
      entry.type !== 'message' ||
      message?.role !== 'user' ||
      message.customType ||
      message.source
    )
      continue
    if (
      typeof message.content !== 'string' &&
      (!Array.isArray(message.content) ||
        !message.content.every(
          (part: { type?: string; text?: unknown }) =>
            part?.type === 'text' && typeof part.text === 'string',
        ))
    )
      continue
    const text = extractText(message.content)
    const observedAt = Date.parse(entry.timestamp ?? '')
    if (!text || text.length > 16_000 || !Number.isSafeInteger(observedAt) || observedAt < 0)
      continue
    result.push({
      ...authority,
      sessionId,
      entryId: entry.id,
      parentId: entry.parentId ?? null,
      rootIds: [entry.id],
      role: 'user',
      label: 'New user message',
      observedAt,
      text,
    })
  }
  return result
}

/** Only a newly admitted lane is observed. Existing entries become a permanent baseline. */
export async function attachBrainCapture(
  live: LiveSession,
  store: DesktopMemoryClient,
  epoch: number,
  onError: (error: unknown) => void,
): Promise<() => void> {
  if (live.owner) throw new Error('Processor sessions cannot be captured')
  const initial = await live.client.request({ type: 'get_entries' })
  const state = await live.client.request({ type: 'get_state' })
  if (!initial.success || !initial.data || !state.success || !state.data?.sessionId)
    throw new Error('Brain capture baseline unavailable')
  bounded(initial.data.entries, 1_000_000)
  if (initial.data.entries.length > 4000) throw new Error('Brain capture baseline exceeds limit')
  const seen = new Set(
    initial.data.entries.map((raw) => {
      const id = (raw as Entry)?.id
      if (typeof id !== 'string') throw new Error('Brain capture baseline identity unavailable')
      return id
    }),
  )
  const nativeId = state.data.sessionId
  let disposed = false
  let tail = Promise.resolve()
  const scan = async (): Promise<void> => {
    if (disposed) return
    const snapshot = await store.snapshot()
    if (!snapshot.prefs.enabled || snapshot.policyEpoch !== epoch) {
      disposed = true
      return
    }
    const authority = await laneAuthority(live.workspacePath)
    if (!snapshot.prefs.workspaces.includes(authority.scope)) return
    const response = await live.client.request({ type: 'get_entries' })
    if (!response.success || !response.data) throw new Error('Brain capture entries unavailable')
    const captures = newUserCaptures(response.data.entries, seen, authority, nativeId)
    for (const capture of captures) {
      if (disposed || (await store.snapshot()).policyEpoch !== epoch) return
      await store.captureAt(epoch, capture)
    }
  }
  const schedule = (event: PiEvent): void => {
    if (event.type === 'agent_end') tail = tail.then(scan).catch(onError)
  }
  live.client.on('event', schedule)
  return () => {
    disposed = true
    live.client.off('event', schedule)
  }
}
