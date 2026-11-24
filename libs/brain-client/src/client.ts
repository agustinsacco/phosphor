import type { BrainAgentMap } from '@phosphor/shared/brain'
import type { BrainQuery, BrainSearchResult } from '@phosphor/shared/brain-recall'
import type { BrainTransport } from './port'
import {
  isBrainRecall,
  isBrainFlagResponse,
  validateBrainRequest,
  SEARCH_GUIDANCE,
} from './validate'

export type { BrainConnection, BrainTransport } from './port'
export { formatBrainRecall, brainBriefing } from './format'

export type BrainClientErrorCode =
  'invalid_connection' | 'connection' | 'timeout' | 'aborted' | 'oversized' | 'malformed' | 'remote'
export class BrainClientError extends Error {
  constructor(
    readonly code: BrainClientErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'BrainClientError'
  }
}
export interface BrainClient {
  search(query: BrainQuery, signal?: AbortSignal): Promise<BrainSearchResult>
  flag(
    input: BrainAgentMap['flag']['request'],
    signal?: AbortSignal,
  ): Promise<BrainAgentMap['flag']['result']>
}
export function createBrainClient(transport: BrainTransport): BrainClient {
  return {
    async flag(input, signal) {
      try {
        validateBrainRequest('flag', input)
      } catch {
        throw new BrainClientError(
          'malformed',
          'Brain flag needs a known memory and a reason of 1 to 300 characters.',
        )
      }
      const data: unknown = await transport.request('flag', input, signal)
      if (!isBrainFlagResponse(data))
        throw new BrainClientError('malformed', 'Brain flag returned an invalid result')
      return data
    },
    async search(query, signal) {
      try {
        validateBrainRequest('search', query)
      } catch {
        throw new BrainClientError('malformed', SEARCH_GUIDANCE)
      }
      const data: unknown = await transport.request('search', query, signal)
      if (!isBrainRecall(data))
        throw new BrainClientError('malformed', 'Brain search returned an invalid result')
      return data
    },
  }
}
