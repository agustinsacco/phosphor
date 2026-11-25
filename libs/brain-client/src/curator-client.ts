import type { BrainAgentMap } from '@phosphor/shared/brain-agent'
import { BrainClientError } from './client'
import type { BrainTransport } from './port'
import { CURATOR_RESULT_GUARDS } from './curator-results'
import { isBrainRecall, validateBrainRequest } from './validate'
import { type BrainCuratorMethod, validateCuratorRequest } from './validate-curator'

export type BrainCuratorCall = BrainCuratorMethod | 'search'

/** The transport waits at least as long as the slowest curator call (embedding a correction). */
export const BRAIN_CURATOR_TIMEOUT_MS = 120_000
export const BRAIN_CURATOR_TIMEOUTS: Record<BrainCuratorCall, number> = {
  search: 30_000,
  waiting: 30_000,
  suggestion: 30_000,
  entity: 30_000,
  memory: 30_000,
  relate: 60_000,
  resolve: 60_000,
  edit: 60_000,
  // Embeds the corrected sentence with the local model.
  correct: 120_000,
  erase: 60_000,
  undo: 60_000,
}

export interface BrainCuratorClient {
  call<M extends BrainCuratorCall>(
    method: M,
    request: BrainAgentMap[M]['request'],
    signal?: AbortSignal,
  ): Promise<BrainAgentMap[M]['result']>
}

/**
 * Brain Agent's client. Requests are validated before they leave (a refusal names the field),
 * results are checked before a tool formats them. The transport's own deadline must be at
 * least BRAIN_CURATOR_TIMEOUT_MS; each method's shorter one rides on the signal.
 */
export function createBrainCuratorClient(
  transport: BrainTransport,
  timeouts: Record<BrainCuratorCall, number> = BRAIN_CURATOR_TIMEOUTS,
): BrainCuratorClient {
  return {
    async call(method, request, signal) {
      let params: typeof request
      try {
        params = (
          method === 'search'
            ? validateBrainRequest('search', request)
            : validateCuratorRequest(method as BrainCuratorMethod, request)
        ) as typeof request
      } catch (error) {
        throw new BrainClientError(
          'malformed',
          error instanceof Error ? error.message : `Brain ${method} request is invalid`,
        )
      }
      const deadline = AbortSignal.timeout(timeouts[method])
      const data: unknown = await transport.request(
        method,
        params,
        signal ? AbortSignal.any([signal, deadline]) : deadline,
      )
      const valid =
        method === 'search'
          ? isBrainRecall(data)
          : CURATOR_RESULT_GUARDS[method as BrainCuratorMethod](data)
      if (!valid)
        throw new BrainClientError('malformed', `Brain ${method} returned an invalid result`)
      return data as never
    },
  }
}
