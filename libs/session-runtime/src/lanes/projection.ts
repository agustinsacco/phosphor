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

export function createLaneProjection(options: { now: () => number; overflow: () => void }) {
  let state: RpcSessionState | null = null
  let messages: AgentMessage[] = []
  let tail: PiEvent[] = []
  let run: PiEvent | undefined
  let queue: Extract<PiEvent, { type: 'queue_update' }> | undefined
  let retry: PiEvent | undefined
  let compaction: PiEvent | undefined
  let ended: 'stopped' | 'failed' | undefined
  let active = false
  let messageStarted = false
  let discarding = false
  let barrier: PiEvent[] | undefined
  let sinceMark: AgentMessage[] | undefined
  const dialogs = new Map<string, { request: ExtensionUIRequest; expires?: number }>()
  const statuses = new Map<string, ExtensionUIRequest>()
  const widgets = new Map<string, ExtensionUIRequest>()
  let title: ExtensionUIRequest | undefined
  let sequence = 0
  const order = new WeakMap<PiEvent, number>()
  const pending = () =>
    barrier ??
    [
      ...(run ? [run] : []),
      ...(queue ? [queue] : []),
      ...(retry ? [retry] : []),
      ...(compaction ? [compaction] : []),
      ...tail,
    ].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
  function expireDialogs() {
    for (const [id, dialog] of dialogs)
      if (dialog.expires !== undefined && dialog.expires <= options.now()) dialogs.delete(id)
  }
  function checkBounds() {
    const events = pending()
    if (
      events.length > HOST_LIMITS.pendingEvents ||
      new TextEncoder().encode(JSON.stringify(events)).length > HOST_LIMITS.replayBytes
    ) {
      discarding ||= messageStarted
      tail = []
      barrier = barrier ? (run ? [run] : []) : undefined
      sinceMark = undefined
      queue = retry = undefined
      options.overflow()
    }
  }
  function event(event: PiEvent) {
    order.set(event, ++sequence)
    if (event.type === 'message_start') messageStarted = true
    if (event.type === 'agent_start') {
      run = event
      active = true
      ended = undefined
      return
    }
    if (event.type === 'queue_update') {
      queue = event
      return
    }
    if (event.type === 'message_end' && event.message.role === 'user' && queue) {
      const content = event.message.content
      const text =
        typeof content === 'string'
          ? content
          : content
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('')
      const steering = [...queue.steering],
        followUp = [...queue.followUp]
      const index = steering.indexOf(text)
      if (index >= 0) steering.splice(index, 1)
      else {
        const index = followUp.indexOf(text)
        if (index >= 0) followUp.splice(index, 1)
      }
      queue = { type: 'queue_update', steering, followUp }
      order.set(queue, sequence)
    }
    if (event.type === 'message_end') {
      if (discarding && barrier && event.message.role === 'assistant') {
        const start: PiEvent = { type: 'message_start', message: event.message }
        order.set(start, sequence - 0.5)
        barrier.push(start)
      }
      messageStarted = discarding = false
      if (!barrier) messages = [...messages, event.message]
      if (sinceMark) {
        if (sinceMark.length < HOST_LIMITS.pendingEvents) sinceMark.push(event.message)
        else {
          sinceMark = undefined
          options.overflow()
        }
      }
      const message = event.message
      tail = tail.filter(
        (e) =>
          executionEvent(e) &&
          !(message.role === 'toolResult' && e.toolCallId === message.toolCallId),
      )
      return
    }
    if (event.type === 'auto_retry_start') {
      retry = event
      return
    }
    if (
      event.type === 'compaction_start' ||
      event.type === 'extension_error' ||
      (event.type === 'auto_retry_end' && !event.success)
    ) {
      // Hydration cannot reconstruct these dividers or their position in the live chat.
      barrier ??= pending()
      if (event.type === 'compaction_start') {
        compaction = event
        return
      }
    }
    if (event.type === 'auto_retry_end') retry = undefined
    if (event.type === 'compaction_end') compaction = undefined
    if (event.type === 'agent_end') {
      retry = undefined
      if (!event.willRetry && !queue?.steering.length && !queue?.followUp.length) {
        run = undefined
        active = false
      }
    }
    if (event.type === 'agent_settled') {
      run = undefined
      active = false
      retry = undefined
      queue = undefined
    }
    tail = appendEvent(tail, event)
  }
  function appendEvent(events: PiEvent[], event: PiEvent): PiEvent[] {
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
          assistantMessageEvent: {
            ...delta,
            delta: last.assistantMessageEvent.delta + delta.delta,
          },
        }
        order.set(merged, sequence)
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
  return {
    apply(push: LanePiPush) {
      if (push.kind === 'event') {
        if (discarding && push.event.type === 'message_update') return
        event(push.event)
        if (barrier) barrier = appendEvent(barrier, push.event)
        checkBounds()
      } else if (push.kind === 'exit') {
        ended = push.expected || push.code === 0 ? 'stopped' : 'failed'
        state = null
        messageStarted = discarding = false
        tail = []
        barrier = undefined
        sinceMark = undefined
        queue = undefined
        active = false
        run = undefined
        retry = undefined
        compaction = undefined
        dialogs.clear()
      } else {
        const request = push.request
        if (request.method === 'setStatus') {
          if (request.statusText === undefined) statuses.delete(request.statusKey)
          else if (statuses.has(request.statusKey) || statuses.size < HOST_LIMITS.uiStatusKeys)
            statuses.set(request.statusKey, request)
          else options.overflow()
        } else if (request.method === 'setWidget') {
          if (!request.widgetLines?.length) widgets.delete(request.widgetKey)
          else if (widgets.has(request.widgetKey) || widgets.size < HOST_LIMITS.uiWidgetKeys)
            widgets.set(request.widgetKey, request)
          else options.overflow()
        } else if (request.method === 'setTitle') title = request
        else if (
          request.method === 'select' ||
          request.method === 'confirm' ||
          request.method === 'input' ||
          request.method === 'editor'
        ) {
          expireDialogs()
          if (dialogs.has(request.id) || dialogs.size < HOST_LIMITS.pendingEvents)
            dialogs.set(request.id, {
              request,
              expires:
                'timeout' in request && request.timeout !== undefined
                  ? options.now() + request.timeout
                  : undefined,
            })
          else options.overflow()
        }
      }
    },
    markSettle() {
      sinceMark = []
    },
    settle(nextMessages: readonly AgentMessage[], nextState: RpcSessionState | null) {
      if (compaction) return
      messages = [...nextMessages]
      const marked = (sinceMark ?? []).map(messageJson)
      const recent = marked.length ? nextMessages.slice(-marked.length).map(messageJson) : []
      let matched = Math.min(recent.length, marked.length)
      while (
        matched &&
        !marked.slice(0, matched).every((m, i) => m === recent[recent.length - matched + i])
      )
        matched--
      messages.push(...(sinceMark ?? []).slice(matched))
      sinceMark = undefined
      state = nextState
      if (nextState) ended = undefined
      // The refreshed transcript includes compaction; keep only the later live tail.
      const compacted = tail.findLastIndex((event) => event.type === 'compaction_end')
      if (compacted >= 0) tail = tail.slice(compacted + 1)
      tail = tail.filter(
        (event) =>
          !executionEvent(event) &&
          event.type !== 'extension_error' &&
          !(event.type === 'auto_retry_end' && !event.success),
      )
      barrier = undefined
      active = !!run || !!nextState?.isStreaming || !!nextState?.isCompacting
    },
    setState(nextState: RpcSessionState | null) {
      state = nextState
      active = !!run || !!nextState?.isStreaming || !!nextState?.isCompacting
    },
    resolveDialog(id: string) {
      dialogs.delete(id)
    },
    view(): LaneProjectionView {
      expireDialogs()
      return {
        state,
        messages: [...messages],
        pending: pending(),
        dialogs: [...dialogs.values()].map((d) => d.request),
        ui: [...statuses.values(), ...widgets.values(), ...(title ? [title] : [])],
      }
    },
    activity(): LaneActivity {
      expireDialogs()
      return (
        ended ?? (dialogs.size ? 'needs-input' : active || compaction || retry ? 'working' : 'idle')
      )
    },
  }
}

export type LaneProjection = ReturnType<typeof createLaneProjection>
