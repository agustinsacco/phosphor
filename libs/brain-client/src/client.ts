import type {
  BrainAgentMap,
  BrainAgentMethod,
  BrainEvidence,
  BrainJob,
  BrainProposalInput,
  BrainQuery,
  BrainSearchResult,
} from '@phosphor/shared/brain'
import type { BrainTransport } from './port'
import { BRAIN_RESULT_VALIDATORS } from './validate'

export type { BrainConnection, BrainTransport } from './port'
export {
  brainDataBlock,
  clipBrainText,
  describeBrainClaim,
  describeBrainEvidence,
  escapeBrainText,
  fitBrainGroups,
  type BrainDataSource,
} from './format'

/**
 * Every failure a Brain caller can see. Messages never carry the capability
 * token, the endpoint path or remote stack traces, so callers may surface them.
 */
export type BrainClientErrorCode =
  'invalid_connection' | 'connection' | 'timeout' | 'aborted' | 'oversized' | 'malformed' | 'remote'

export class BrainClientError extends Error {
  readonly code: BrainClientErrorCode

  constructor(code: BrainClientErrorCode, message: string) {
    super(message)
    this.name = 'BrainClientError'
    this.code = code
  }
}

export interface BrainJobBundle {
  job: BrainJob
  evidence: BrainEvidence[]
}

/** Typed agent-side calls. Scope, job and fence come from the token, never from params. */
export interface BrainClient {
  search(query: BrainQuery, signal?: AbortSignal): Promise<BrainSearchResult>
  read(evidenceId: string, signal?: AbortSignal): Promise<BrainEvidence>
  brief(query: string, signal?: AbortSignal): Promise<BrainSearchResult>
  job(signal?: AbortSignal): Promise<BrainJobBundle>
  propose(input: BrainProposalInput, signal?: AbortSignal): Promise<{ proposalId: string }>
}

export function createBrainClient(transport: BrainTransport): BrainClient {
  async function call<M extends BrainAgentMethod>(
    method: M,
    params: BrainAgentMap[M]['request'],
    signal: AbortSignal | undefined,
  ): Promise<BrainAgentMap[M]['result']> {
    const data: unknown = await transport.request(method, params, signal)
    if (!BRAIN_RESULT_VALIDATORS[method](data)) {
      throw new BrainClientError('malformed', `Brain ${method} returned an invalid result`)
    }
    return data
  }
  return {
    search: (query, signal) => call('search', query, signal),
    read: (evidenceId, signal) => call('read', { evidenceId }, signal),
    brief: (query, signal) => call('brief', { query }, signal),
    job: (signal) => call('job', {}, signal),
    propose: (input, signal) => call('propose', { input }, signal),
  }
}
