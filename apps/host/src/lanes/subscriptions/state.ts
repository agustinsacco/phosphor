import type {
  ClientFrame,
  FrameSocket,
  HostFrame,
  StreamCursor,
} from '@phosphor/shared/host-protocol'
import type { LaneStreams, LanesTopic, StreamLimits } from '../stream'

export type Subscribe = Extract<ClientFrame, { type: 'subscribe'; topic: 'lanes' | 'lane' }>
export type Subscription = {
  request: Subscribe
  stale: boolean
  cursor?: StreamCursor
  recovery?: { cursor: StreamCursor; after?: StreamCursor }
  drop(): void
}
export type Failure = Extract<HostFrame, { type: 'subscribe-failed' }>['code']
export type SubscriptionLog = (
  message: string,
  data: { topic: Subscribe['topic']; code: Failure; trace?: string },
) => void

export type SubscriptionState = {
  socket: FrameSocket
  streams: LaneStreams
  lanesTopic: LanesTopic
  limits: StreamLimits
  log: SubscriptionLog
  subscriptions: Map<string, Subscription>
  timer?: ReturnType<typeof setInterval>
  closed: boolean
}
export type RecoverSubscription = (sub: Subscription) => void
