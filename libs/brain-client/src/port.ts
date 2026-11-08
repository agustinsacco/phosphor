import type { BrainAgentMap, BrainAgentMethod } from '@phosphor/shared/brain'

export interface BrainTransport {
  request<M extends BrainAgentMethod>(
    method: M,
    params: BrainAgentMap[M]['request'],
    signal?: AbortSignal,
  ): Promise<BrainAgentMap[M]['result']>
}
/** Node transport accepts only a machine-issued Unix socket / Windows pipe and capability. */
export interface BrainConnection {
  endpoint: string
  token: string
}
