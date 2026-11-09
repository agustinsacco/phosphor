import type {
  ExtensionUIRequest,
  PiEvent,
  RpcCommandType,
  RpcResponse,
  RpcSessionState,
} from '@shared/rpc'

const readOnly = (type: RpcCommandType): boolean => type.startsWith('get_')

/** Conservative main-process facts, including work initiated without a renderer. */
export class SessionActivity {
  private pending = new Map<string, { type: RpcCommandType; revision: number }>()
  private active = new Set<string>()
  private revision = 0
  private unknown = true
  private unsettled = false

  get busy(): boolean {
    return (
      this.unknown ||
      this.unsettled ||
      this.active.size > 0 ||
      [...this.pending.values()].some(({ type }) => !readOnly(type))
    )
  }

  requested(id: string, type: RpcCommandType): void {
    if (!readOnly(type)) this.revision++
    if (['prompt', 'steer', 'follow_up'].includes(type)) this.unsettled = true
    this.pending.set(id, { type, revision: this.revision })
  }

  responded(response: RpcResponse): void {
    const request = response.id ? this.pending.get(response.id) : undefined
    if (!request) return
    this.pending.delete(response.id!)
    if (!response.success) {
      if (!readOnly(request.type)) this.unknown = true
      return
    }
    if (request.type === 'get_state' && request.revision === this.revision) {
      const state = response.data as RpcSessionState | undefined
      if (
        !state ||
        typeof state.isStreaming !== 'boolean' ||
        typeof state.isCompacting !== 'boolean' ||
        !Number.isSafeInteger(state.pendingMessageCount) ||
        state.pendingMessageCount < 0
      )
        return
      this.unknown = false
      this.unsettled = state.isStreaming || state.isCompacting || state.pendingMessageCount > 0
      this.set('agent', state.isStreaming)
      this.set('compaction', state.isCompacting)
      this.set('queue', state.pendingMessageCount > 0)
      // State has no retry, direct-bash, or dialog fields: never erase those.
    }
  }

  failed(id: string): void {
    if (this.pending.delete(id)) this.unknown = true
  }

  event(event: PiEvent): void {
    this.revision++
    switch (event.type) {
      case 'agent_start':
        this.unsettled = true
        this.set('agent', true)
        break
      case 'agent_end':
        this.set('agent', false)
        if (event.willRetry) this.set('retry', true)
        break // End is not settled: queued work or recovery may follow.
      case 'agent_settled':
        this.unknown = this.unsettled = false
        this.active.delete('agent')
        this.active.delete('retry')
        break
      case 'auto_retry_start':
        this.set('retry', true)
        break
      case 'auto_retry_end':
        this.set('retry', false)
        break
      case 'compaction_start':
        this.set('compaction', true)
        break
      case 'compaction_end':
        this.set('compaction', false)
        if (event.willRetry) this.unsettled = true
        break
      case 'summarization_retry_scheduled':
      case 'summarization_retry_attempt_start':
        this.set('summary', true)
        break
      case 'summarization_retry_finished':
        this.set('summary', false)
        break
      case 'queue_update':
        this.set('queue', event.steering.length + event.followUp.length > 0)
        break
      case 'tool_execution_start':
        this.set(`tool:${event.toolCallId}`, true)
        break
      case 'tool_execution_end':
        this.set(`tool:${event.toolCallId}`, false)
        break
    }
  }

  dialog(request: ExtensionUIRequest): void {
    if (['select', 'confirm', 'input', 'editor'].includes(request.method)) {
      this.revision++
      this.set(`dialog:${request.id}`, true)
    }
  }

  answered(id: string): void {
    this.revision++
    this.active.delete(`dialog:${id}`)
  }

  exited(): void {
    this.revision++
    this.pending.clear()
    this.active.clear()
    this.unknown = this.unsettled = false
  }

  private set(key: string, active: boolean): void {
    if (active) this.active.add(key)
    else this.active.delete(key)
  }
}
