import {
  HOST_LIMITS,
  type LaneActivity,
  type LanePiPush,
  type LaneSnapshot,
} from '@phosphor/shared/host-protocol'
import type {
  AgentMessage,
  ExtensionUIRequest,
  PiEvent,
  RpcSessionState,
} from '@phosphor/shared/rpc'

export type LaneProjectionView = Pick<
  LaneSnapshot,
  'state' | 'messages' | 'pending' | 'dialogs' | 'ui'
>

type ProjectionOptions = { now: () => number; overflow: () => void }
interface ProjectionState {
  session: RpcSessionState | null
  messages: AgentMessage[]
  tail: PiEvent[]
  run?: PiEvent
  queue?: Extract<PiEvent, { type: 'queue_update' }>
  retry?: PiEvent
  compaction?: PiEvent
  ended?: 'stopped' | 'failed'
  active: boolean
  messageStarted: boolean
  discarding: boolean
  barrier?: PiEvent[]
  sinceMark?: AgentMessage[]
  read?: number
  dialogs: Map<string, { request: ExtensionUIRequest; expires?: number }>
  statuses: Map<string, ExtensionUIRequest>
  widgets: Map<string, ExtensionUIRequest>
  title?: ExtensionUIRequest
  sequence: number
  order: WeakMap<PiEvent, number>
}

function executionEvent(event: PiEvent) {
  return (
    event.type === 'tool_execution_start' ||
    event.type === 'tool_execution_update' ||
    event.type === 'tool_execution_end'
  )
}

function messageJson(message: AgentMessage): string {
  return JSON.stringify(message, (_key, value: unknown) =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  )
}

function pending(state: ProjectionState): PiEvent[] {
  return (
    state.barrier ??
    [
      ...(state.run ? [state.run] : []),
      ...(state.queue ? [state.queue] : []),
      ...(state.retry ? [state.retry] : []),
      ...(state.compaction ? [state.compaction] : []),
      ...state.tail,
    ].sort((a, b) => (state.order.get(a) ?? 0) - (state.order.get(b) ?? 0))
  )
}

function expireDialogs(state: ProjectionState, options: ProjectionOptions) {
  for (const [id, dialog] of state.dialogs)
    if (dialog.expires !== undefined && dialog.expires <= options.now()) state.dialogs.delete(id)
}

function checkBounds(state: ProjectionState, options: ProjectionOptions) {
  const events = pending(state)
  if (
    events.length > HOST_LIMITS.pendingEvents ||
    new TextEncoder().encode(JSON.stringify(events)).length > HOST_LIMITS.replayBytes
  ) {
    state.discarding ||= state.messageStarted
    state.tail = []
    state.barrier = state.barrier ? (state.run ? [state.run] : []) : undefined
    state.sinceMark = undefined
    state.queue = state.retry = undefined
    options.overflow()
  }
}

function removeQueuedMessage(state: ProjectionState, message: AgentMessage) {
  if (message.role !== 'user' || !state.queue) return
  const content = message.content
  const text =
    typeof content === 'string'
      ? content
      : content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('')
  const steering = [...state.queue.steering],
    followUp = [...state.queue.followUp]
  const index = steering.indexOf(text)
  if (index >= 0) steering.splice(index, 1)
  else {
    const index = followUp.indexOf(text)
    if (index >= 0) followUp.splice(index, 1)
  }
  state.queue = { type: 'queue_update', steering, followUp }
  state.order.set(state.queue, state.sequence)
}

function reduceMessageEnd(
  state: ProjectionState,
  options: ProjectionOptions,
  message: AgentMessage,
) {
  removeQueuedMessage(state, message)
  if (state.discarding && state.barrier && message.role === 'assistant') {
    const start: PiEvent = { type: 'message_start', message }
    state.order.set(start, state.sequence - 0.5)
    state.barrier.push(start)
  }
  state.messageStarted = state.discarding = false
  if (!state.barrier) state.messages = [...state.messages, message]
  if (state.sinceMark) {
    if (state.sinceMark.length < HOST_LIMITS.pendingEvents) state.sinceMark.push(message)
    else {
      state.sinceMark = undefined
      options.overflow()
    }
  }
  if (state.barrier && message.role === 'toolResult')
    state.barrier = state.barrier.filter(
      (e) => !executionEvent(e) || e.toolCallId !== message.toolCallId,
    )
  state.tail = state.tail.filter(
    (e) =>
      executionEvent(e) && !(message.role === 'toolResult' && e.toolCallId === message.toolCallId),
  )
}

function reduceRunEvent(state: ProjectionState, event: PiEvent): boolean {
  if (event.type === 'auto_retry_start') {
    state.retry = event
    return true
  }
  if (
    event.type === 'compaction_start' ||
    event.type === 'extension_error' ||
    (event.type === 'auto_retry_end' && !event.success)
  ) {
    // Hydration cannot reconstruct these dividers or their position in the live chat.
    state.barrier ??= pending(state)
    if (event.type === 'compaction_start') {
      state.compaction = event
      return true
    }
  }
  if (event.type === 'auto_retry_end') state.retry = undefined
  if (event.type === 'compaction_end') state.compaction = undefined
  if (event.type === 'agent_end') {
    state.retry = undefined
    if (!event.willRetry && !state.queue?.steering.length && !state.queue?.followUp.length) {
      state.run = undefined
      state.active = false
    }
  }
  if (event.type === 'agent_settled') {
    state.run = undefined
    state.active = false
    state.retry = undefined
    state.queue = undefined
  }
  return false
}

function applyEvent(state: ProjectionState, options: ProjectionOptions, event: PiEvent) {
  state.order.set(event, ++state.sequence)
  if (event.type === 'message_start') state.messageStarted = true
  if (event.type === 'agent_start') {
    state.run = event
    state.active = true
    state.ended = undefined
    return
  }
  if (event.type === 'queue_update') {
    state.queue = event
    return
  }
  if (event.type === 'message_end') {
    reduceMessageEnd(state, options, event.message)
    return
  }
  if (!reduceRunEvent(state, event)) state.tail = appendEvent(state, state.tail, event)
}

function appendEvent(state: ProjectionState, events: PiEvent[], event: PiEvent): PiEvent[] {
  if (event.type === 'message_update') {
    const delta = event.assistantMessageEvent
    const last = events.at(-1)
    if (
      (delta.type === 'text_delta' ||
        delta.type === 'thinking_delta' ||
        delta.type === 'toolcall_delta') &&
      last?.type === 'message_update' &&
      last.assistantMessageEvent.type === delta.type &&
      last.assistantMessageEvent.contentIndex === delta.contentIndex
    ) {
      const merged: PiEvent = {
        ...event,
        assistantMessageEvent: { ...delta, delta: last.assistantMessageEvent.delta + delta.delta },
      }
      state.order.set(merged, state.sequence)
      events[events.length - 1] = merged
      return events
    }
  }
  if (event.type === 'tool_execution_update')
    events = events.filter(
      (e) => e.type !== 'tool_execution_update' || e.toolCallId !== event.toolCallId,
    )
  events.push(event)
  return events
}

function applyExit(state: ProjectionState, push: Extract<LanePiPush, { kind: 'exit' }>) {
  state.ended = push.expected || push.code === 0 ? 'stopped' : 'failed'
  state.session = null
  state.messageStarted = state.discarding = false
  state.tail = []
  state.barrier = undefined
  state.sinceMark = undefined
  state.queue = undefined
  state.active = false
  state.run = undefined
  state.retry = undefined
  state.compaction = undefined
  state.dialogs.clear()
}

function applyUi(state: ProjectionState, options: ProjectionOptions, request: ExtensionUIRequest) {
  if (request.method === 'setStatus') {
    if (request.statusText === undefined) state.statuses.delete(request.statusKey)
    else if (
      state.statuses.has(request.statusKey) ||
      state.statuses.size < HOST_LIMITS.uiStatusKeys
    )
      state.statuses.set(request.statusKey, request)
    else options.overflow()
  } else if (request.method === 'setWidget') {
    if (!request.widgetLines?.length) state.widgets.delete(request.widgetKey)
    else if (state.widgets.has(request.widgetKey) || state.widgets.size < HOST_LIMITS.uiWidgetKeys)
      state.widgets.set(request.widgetKey, request)
    else options.overflow()
  } else if (request.method === 'setTitle') state.title = request
  else if (
    request.method === 'select' ||
    request.method === 'confirm' ||
    request.method === 'input' ||
    request.method === 'editor'
  ) {
    expireDialogs(state, options)
    if (state.dialogs.has(request.id) || state.dialogs.size < HOST_LIMITS.pendingEvents)
      state.dialogs.set(request.id, {
        request,
        expires:
          'timeout' in request && request.timeout !== undefined
            ? options.now() + request.timeout
            : undefined,
      })
    else options.overflow()
  }
}

function apply(state: ProjectionState, options: ProjectionOptions, push: LanePiPush) {
  if (push.kind === 'event') {
    if (state.discarding && push.event.type === 'message_update') return
    applyEvent(state, options, push.event)
    if (state.barrier) state.barrier = appendEvent(state, state.barrier, push.event)
    checkBounds(state, options)
  } else if (push.kind === 'exit') applyExit(state, push)
  else applyUi(state, options, push.request)
}

function settle(
  state: ProjectionState,
  nextMessages: readonly AgentMessage[],
  nextState: RpcSessionState | null,
) {
  if (state.compaction) return
  state.messages = [...nextMessages]
  const marked = (state.sinceMark ?? []).map(messageJson)
  const recent = marked.length ? nextMessages.slice(-marked.length).map(messageJson) : []
  let matched = Math.min(state.read ?? marked.length, recent.length, marked.length)
  while (
    matched &&
    !marked.slice(0, matched).every((m, i) => m === recent[recent.length - matched + i])
  )
    matched--
  state.messages.push(...(state.sinceMark ?? []).slice(matched))
  state.sinceMark = undefined
  state.session = nextState
  if (nextState) state.ended = undefined
  // The refreshed transcript includes compaction; keep only the later live tail.
  const compacted = state.tail.findLastIndex((event) => event.type === 'compaction_end')
  if (compacted >= 0) state.tail = state.tail.slice(compacted + 1)
  state.tail = state.tail.filter(
    (event) =>
      !executionEvent(event) &&
      event.type !== 'extension_error' &&
      !(event.type === 'auto_retry_end' && !event.success),
  )
  state.barrier = undefined
  state.active = !!state.run || !!nextState?.isStreaming || !!nextState?.isCompacting
}

function view(state: ProjectionState, options: ProjectionOptions): LaneProjectionView {
  expireDialogs(state, options)
  return {
    state: state.session,
    messages: [...state.messages],
    pending: pending(state),
    dialogs: [...state.dialogs.values()].map((d) => d.request),
    ui: [
      ...state.statuses.values(),
      ...state.widgets.values(),
      ...(state.title ? [state.title] : []),
    ],
  }
}

function activity(state: ProjectionState, options: ProjectionOptions): LaneActivity {
  expireDialogs(state, options)
  return (
    state.ended ??
    (state.dialogs.size
      ? 'needs-input'
      : state.active || state.compaction || state.retry
        ? 'working'
        : 'idle')
  )
}

export function createLaneProjection(options: ProjectionOptions) {
  const state: ProjectionState = {
    session: null,
    messages: [],
    tail: [],
    active: false,
    messageStarted: false,
    discarding: false,
    dialogs: new Map(),
    statuses: new Map(),
    widgets: new Map(),
    sequence: 0,
    order: new WeakMap(),
  }
  return {
    apply: (push: LanePiPush) => apply(state, options, push),
    markSettle() {
      state.sinceMark = []
      state.read = undefined
    },
    markRead() {
      // The RPC continuation follows the current stdout chunk. A later message in that
      // same chunk can count as read, but a wrong overlap needs deep equality, including
      // pi's millisecond timestamp.
      state.read = state.sinceMark?.length
    },
    settle: (messages: readonly AgentMessage[], nextState: RpcSessionState | null) =>
      settle(state, messages, nextState),
    setState(nextState: RpcSessionState | null) {
      state.session = nextState
      state.active = !!state.run || !!nextState?.isStreaming || !!nextState?.isCompacting
    },
    resolveDialog: (id: string) => {
      state.dialogs.delete(id)
    },
    view: () => view(state, options),
    activity: () => activity(state, options),
  }
}

export type LaneProjection = ReturnType<typeof createLaneProjection>
