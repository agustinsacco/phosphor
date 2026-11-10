import type { BrainQuery, BrainRecall } from '@phosphor/shared/brain'
import type { BrainTransport } from './port'
import { isBrainRecall, validateBrainRequest } from './validate'

export type { BrainConnection, BrainTransport } from './port'
export { formatBrainRecall } from './format'

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
  search(query: BrainQuery, signal?: AbortSignal): Promise<BrainRecall>
}
export function createBrainClient(transport: BrainTransport): BrainClient {
  return {
    async search(query, signal) {
      try {
        validateBrainRequest('search', query)
      } catch {
        throw new BrainClientError('malformed', 'Brain search request is invalid')
      }
      const data: unknown = await transport.request('search', query, signal)
      if (!isBrainRecall(data))
        throw new BrainClientError('malformed', 'Brain search returned an invalid result')
      return data
    },
  }
}
