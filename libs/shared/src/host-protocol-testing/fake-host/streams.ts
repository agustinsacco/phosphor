import {
  HOST_LIMITS,
  utf8Length,
  type AttentionEvent,
  type HostFrame,
  type LaneEvent,
  type LaneSnapshot,
  type LaneSummary,
} from '../../host-protocol'
import type { AgentMessage, PiEvent } from '../../rpc'
import type { SendFrame } from './delivery'
import { now, type FakeHostState, type Lane } from './state'

/** A lane's snapshot; transcript, pending, dialog and UI collections are the lane's own values. */
export function snapshot(state: FakeHostState, lane: Lane): LaneSnapshot {
  return {
    cursor: { epoch: state.epoch, seq: lane.seq },
    summary: lane.summary,
    state:
      lane.summary.activity === 'stopped' || lane.summary.activity === 'failed'
        ? null
        : {
            sessionId: lane.sessionId,
            thinkingLevel: lane.thinkingLevel,
            isStreaming: lane.summary.activity === 'working',
            isCompacting: false,
            steeringMode: 'all',
            followUpMode: 'all',
            autoCompactionEnabled: true,
            messageCount: lane.messages.length,
            pendingMessageCount: lane.pending.length,
            ...(lane.summary.title !== null ? { sessionName: lane.summary.title } : {}),
          },
    messages: lane.messages,
    pending: lane.pending,
    dialogs: lane.dialogs,
    ui: [...lane.ui.values()],
  }
}

/** Appends to the lane's replay window, then streams the event to every lane subscription. */
export function publish(state: FakeHostState, send: SendFrame, lane: Lane, event: LaneEvent) {
  const limits = state.limits
  const entry = {
    cursor: { epoch: state.epoch, seq: ++lane.seq },
    event,
    bytes: utf8Length(JSON.stringify(event)),
  }
  lane.events.push(entry)
  lane.replayBytes += entry.bytes
  while (lane.events.length > limits.replayEvents || lane.replayBytes > limits.replayBytes) {
    const old = lane.events.shift()
    if (old) lane.replayBytes -= old.bytes
  }
  for (const c of state.connections)
    for (const s of c.subscriptions.values()) {
      if (s.topic === 'lane' && s.laneId === lane.summary.laneId) {
        const frame: HostFrame = {
          type: 'event',
          id: s.id,
          laneId: s.laneId,
          cursor: entry.cursor,
          event,
        }
        if (utf8Length(JSON.stringify(frame)) > limits.outboundFrameBytes)
          send(state, c, {
            type: 'snapshot',
            id: s.id,
            laneId: s.laneId,
            reset: true,
            snapshot: snapshot(state, lane),
          })
        else send(state, c, frame)
      }
    }
}

export function summary(state: FakeHostState, send: SendFrame, lane: Lane) {
  lane.summary = { ...lane.summary, updatedAt: now() }
  publish(state, send, lane, { kind: 'summary', summary: lane.summary })
  announce(state, send, lane)
}

export function announce(state: FakeHostState, send: SendFrame, lane: Lane) {
  const cursor = { epoch: state.epoch, seq: ++state.hostSeq }
  for (const c of state.connections)
    for (const s of c.subscriptions.values())
      if (s.topic === 'lanes')
        send(state, c, {
          type: 'lanes-delta',
          id: s.id,
          cursor,
          upsert: [lane.summary],
          remove: [],
        })
}

export function notify(
  state: FakeHostState,
  send: SendFrame,
  lane: Lane,
  kind: AttentionEvent['kind'],
) {
  lane.summary = { ...lane.summary, attention: lane.summary.attention + 1 }
  summary(state, send, lane)
  const entry = {
    cursor: { epoch: state.epoch, seq: ++state.hostSeq },
    event: {
      id: `${lane.summary.laneId}:${lane.summary.attention}`,
      laneId: lane.summary.laneId,
      kind,
      attention: lane.summary.attention,
      at: now(),
      title: lane.summary.title,
    },
  }
  state.attention.push(entry)
  while (state.attention.length > state.limits.attentionReplay) state.attention.shift()
  for (const c of state.connections)
    for (const s of c.subscriptions.values())
      if (s.topic === 'lanes') send(state, c, { type: 'attention', id: s.id, ...entry })
}

export function changeControl(
  state: FakeHostState,
  send: SendFrame,
  lane: Lane,
  controller: LaneSummary['control']['controller'],
) {
  lane.summary = {
    ...lane.summary,
    control: { fence: lane.summary.control.fence + 1, controller },
  }
  publish(state, send, lane, { kind: 'control', control: lane.summary.control })
  summary(state, send, lane)
}

export function push(state: FakeHostState, send: SendFrame, lane: Lane, event: PiEvent) {
  if (lane.pending.length >= state.limits.pendingEvents)
    throw new Error('Scripted pending limit exceeded')
  lane.pending.push(event)
  publish(state, send, lane, { kind: 'pi', push: { kind: 'event', event } })
}

/** Scripts one complete assistant turn and returns how much it added. */
export function turn(state: FakeHostState, send: SendFrame, lane: Lane) {
  const messageCount = lane.messages.length
  lane.summary = { ...lane.summary, activity: 'working' }
  summary(state, send, lane)
  push(state, send, lane, { type: 'agent_start' })
  const message: AgentMessage = {
    role: 'assistant',
    content: [{ type: 'text', text: 'Scripted reply' }],
    timestamp: Date.now(),
  }
  // The fake's deltas are intentionally shallow; pi owns the inner event shape.
  for (const delta of ['Scripted ', 'reply'])
    push(state, send, lane, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta },
    })
  push(state, send, lane, { type: 'message_end', message })
  lane.messages.push(message)
  // A fake transcript stops growing at the wire cap; it never silently truncates history.
  if (utf8Length(JSON.stringify(lane.messages)) > HOST_LIMITS.outboundFrameBytes)
    throw new Error('Scripted transcript limit exceeded')
  lane.pending.length = 0
  push(state, send, lane, { type: 'agent_end', messages: [message] })
  lane.pending.length = 0
  lane.summary = { ...lane.summary, activity: 'idle' }
  notify(state, send, lane, 'finished')
  return { messages: lane.messages.length - messageCount, turns: 1 }
}
