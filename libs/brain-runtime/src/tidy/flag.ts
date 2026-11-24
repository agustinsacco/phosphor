import type { BrainFlagResponse } from '@phosphor/shared/brain'
import type { BrainTidyFlag } from '@phosphor/shared/brain-tidy'
import type { BrainStore } from '@phosphor/memory-engine/types'
import { validateBrainRequest } from '@phosphor/brain-client/validate'

/** Engine owns persisted per-memory and per-session deduplication, atomically. */
export interface BrainFlagPort {
  flag(input: BrainTidyFlag): { status: BrainFlagResponse['status']; suggestionId: string | null }
}
const MESSAGES: Record<BrainFlagResponse['status'], string> = {
  filed: 'Flag filed for Brain Agent to check; Brain knowledge has not changed.',
  already_flagged: 'This memory is already flagged; Brain knowledge has not changed.',
  limit:
    'Brain accepts five open flags per lane and 50 in total. Wait for Brain Agent to check some before flagging more; Brain knowledge has not changed.',
  unavailable: 'This memory cannot be flagged right now; Brain knowledge has not changed.',
}
export function flagResponse(status: BrainFlagResponse['status']): BrainFlagResponse {
  return { status, message: MESSAGES[status] }
}
export function fileBrainFlag(
  store: Pick<BrainStore, 'memory'>,
  port: BrainFlagPort,
  input: unknown,
): BrainFlagResponse {
  const request = validateBrainRequest('flag', input)
  let state: string
  try {
    state = store.memory(request.memoryId).memory.state
  } catch {
    return flagResponse('unavailable')
  }
  if (state !== 'active' && state !== 'disputed') return flagResponse('unavailable')
  const result = port.flag({
    ...request,
    reason: request.reason.trim().slice(0, 300),
    title: request.title.trim().slice(0, 120),
  })
  return flagResponse(result.status)
}
