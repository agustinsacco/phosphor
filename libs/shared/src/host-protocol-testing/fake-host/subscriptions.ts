import type { ClientFrame, HostFrame } from '../../host-protocol'
import { authorized } from './auth'
import { send } from './delivery'
import type { Connection, FakeHostState } from './state'
import { snapshot } from './streams'

type Subscribe = Extract<ClientFrame, { type: 'subscribe' }>
type LanesSubscribe = Extract<Subscribe, { topic: 'lanes' }>
type LaneSubscribe = Extract<Subscribe, { topic: 'lane' }>
type FailureCode = Extract<HostFrame, { type: 'subscribe-failed' }>['code']

/** Refuses by topic, authority, duplicate id and count, in that order, then subscribes. */
export function subscribe(state: FakeHostState, c: Connection, f: Subscribe) {
  const fail = (code: FailureCode) => send(state, c, { type: 'subscribe-failed', id: f.id, code })
  if (f.topic === 'terminal') fail('bad-request')
  else if (!authorized(state, c, 'sessions.read')) fail('forbidden')
  else if (c.subscriptions.has(f.id)) fail('bad-request')
  else if (c.subscriptions.size >= state.limits.subscriptionsPerConnection) fail('too-many')
  else if (f.topic === 'lanes') subscribeLanes(state, c, f)
  else subscribeLane(state, c, f)
}

export function unsubscribe(c: Connection, id: string) {
  c.subscriptions.delete(id)
  c.stale.delete(id)
}

/** The lanes list, then attention after the cursor in this epoch until a send is not sent. */
function subscribeLanes(state: FakeHostState, c: Connection, f: LanesSubscribe) {
  c.subscriptions.set(f.id, f)
  const result = send(state, c, {
    type: 'lanes',
    id: f.id,
    cursor: { epoch: state.epoch, seq: state.hostSeq },
    repositories: state.repositories,
    lanes: [...state.lanes.values()].map((l) => l.summary),
  })
  if (result !== 'sent') return
  if (f.after?.epoch === state.epoch)
    for (const entry of state.attention)
      if (
        entry.cursor.seq > f.after.seq &&
        send(state, c, { type: 'attention', id: f.id, ...entry }) !== 'sent'
      )
        break
}

/**
 * Replays the missed events when the cursor is in this epoch and inside the replay window, so
 * a cursor at the head sends nothing; otherwise a snapshot, marked reset when a cursor was given.
 */
function subscribeLane(state: FakeHostState, c: Connection, f: LaneSubscribe) {
  const l = state.lanes.get(f.laneId)
  if (!l) {
    send(state, c, { type: 'subscribe-failed', id: f.id, code: 'unknown-lane' })
    return
  }
  c.subscriptions.set(f.id, f)
  if (
    f.after?.epoch === state.epoch &&
    f.after.seq <= l.seq &&
    f.after.seq >= (l.events[0]?.cursor.seq ?? l.seq + 1) - 1
  ) {
    for (const entry of l.events)
      if (entry.cursor.seq > f.after.seq) {
        const result = send(state, c, {
          type: 'event',
          id: f.id,
          laneId: f.laneId,
          cursor: entry.cursor,
          event: entry.event,
        })
        if (result !== 'sent') break
      }
  } else
    send(state, c, {
      type: 'snapshot',
      id: f.id,
      laneId: f.laneId,
      reset: f.after !== undefined,
      snapshot: snapshot(state, l),
    })
}
