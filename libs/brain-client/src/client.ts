import type {
  BrainAgentMap,
  BrainAgentMethod,
  BrainQuery,
  BrainRecall,
} from '@phosphor/shared/brain'
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
  related(query: BrainAgentMap['related']['request'], signal?: AbortSignal): Promise<BrainRecall>
}
export function createBrainClient(transport: BrainTransport): BrainClient {
  async function call<M extends BrainAgentMethod>(
    method: M,
    params: BrainAgentMap[M]['request'],
    signal?: AbortSignal,
  ): Promise<BrainRecall> {
    try {
      validateBrainRequest(method, params)
    } catch {
      throw new BrainClientError('malformed', `Brain ${method} request is invalid`)
    }
    const data: unknown = await transport.request(method, params, signal)
    if (!isBrainRecall(data))
      throw new BrainClientError('malformed', `Brain ${method} returned an invalid result`)
    return data
  }
  return {
    search: (query, signal) => call('search', query, signal),
    related: (query, signal) => call('related', query, signal),
  }
}
