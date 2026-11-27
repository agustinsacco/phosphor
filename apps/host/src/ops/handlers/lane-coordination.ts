import type { LaneActivity } from '@phosphor/shared/host-protocol'
import { LANE_WAIT_TIMEOUT } from '@phosphor/shared/ops'
import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import {
  authenticatedLane,
  MESSAGE_SENDER_REQUIRED,
} from '@phosphor/session-runtime/ops/principals'
import { laneMessageBusy } from '@phosphor/session-runtime/ops/judge'
import { op } from '@phosphor/session-runtime/ops/results'
import { clipBytes } from '@phosphor/session-runtime/ops/route-result'
import type { OpHandlerContext } from '@phosphor/session-runtime/ops/types'
import type { DaemonHandlerDeps } from './index'
import { commandClient, laneCommand, laneId } from './lane-ports'

type MessageArgs = { content: string; mode?: 'follow-up' | 'steer' }
type WaitArgs = { until?: 'idle' | 'settled'; timeout?: number }
type WaitState = LaneActivity | 'removed'
type WaitReason = 'reached' | 'needs-input' | 'ended' | 'timeout'

function agentFrame(from: string, body: string) {
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
  const sender = from.replace(/[&<>"]/g, (c) => entities[c]!)
  const text = body.replace(/[&<>]/g, (c) => entities[c]!)
  return `<phosphor-agent-message from="${sender}" authority="none">\n${text}\n</phosphor-agent-message>`
}

async function messageLane(deps: DaemonHandlerDeps, args: MessageArgs, c: OpHandlerContext) {
  const sender = authenticatedLane(c.principal)
  if (!sender) throw new OpRefusal('forbidden', MESSAGE_SENDER_REQUIRED)
  const id = laneId(deps, c)
  const target = deps.daemonLanes.summary(id)
  if (!target || !deps.daemonLanes.sessionFor(id))
    throw new OpRefusal('unavailable', 'Resume the target lane before messaging it.')
  const busy = laneMessageBusy({ activity: target.activity, controller: target.control.controller })
  if (busy) throw new OpRefusal(busy.code, busy.text)
  if (c.lane?.controlFence !== target.control.fence)
    throw new OpRefusal('busy', 'The lane’s control changed. No message was sent.')
  if (!args.content.trim()) throw new OpRefusal('bad-request', 'Add some message text.')
  const mode = args.mode ?? 'follow-up'
  const client = { ...commandClient(c), agentMessage: true as const }
  try {
    await laneCommand(
      deps,
      client,
      {
        type: 'prompt',
        message: agentFrame(sender, args.content),
        streamingBehavior: mode === 'steer' ? 'steer' : 'followUp',
      },
      { laneId: id, fence: target.control.fence },
    )
  } catch (error) {
    if (!(error instanceof OpRefusal)) throw error
    if (error.code === 'busy')
      throw new OpRefusal(
        'busy',
        'The lane is busy, needs input, or its control changed. No message was sent.',
      )
    throw new OpRefusal(
      error.code,
      'The lane queue did not acknowledge the message. Check the lane before retrying.',
    )
  }
  return { text: `Lane accepted the ${mode} message.` }
}

function waitReason(
  state: WaitState,
  until: NonNullable<WaitArgs['until']>,
): WaitReason | undefined {
  if (state === 'working') return
  if (state === 'needs-input') return 'needs-input'
  if (state === 'removed') return 'ended'
  return state === 'idle' || until === 'settled' ? 'reached' : 'ended'
}

function waitForActivity(deps: DaemonHandlerDeps, id: string, args: WaitArgs, signal: AbortSignal) {
  const { until = 'settled', timeout = LANE_WAIT_TIMEOUT.default } = args
  const current = () => deps.daemonLanes.summary(id)?.activity ?? 'removed'
  return new Promise<{ state: WaitState; reason: WaitReason }>((resolve, reject) => {
    signal.throwIfAborted()
    const finish = (state: WaitState, reason: WaitReason) => {
      cleanup()
      resolve({ state, reason })
    }
    const check = () => {
      const state = current()
      const reason = waitReason(state, until)
      if (reason) finish(state, reason)
    }
    const off = deps.lanes.lanesTopic.listen((event) => {
      if (
        !event ||
        (event.type === 'lanes-delta' &&
          (event.upsert.some((lane) => lane.laneId === id) || event.remove.includes(id)))
      )
        check()
    })
    const timer = setTimeout(() => finish(current(), 'timeout'), timeout * 1000)
    const abort = () => {
      cleanup()
      reject(signal.reason)
    }
    const cleanup = () => {
      off()
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
    signal.addEventListener('abort', abort, { once: true })
    check()
  })
}

const SUMMARY_BYTES = 768
function assistantExcerpt(deps: DaemonHandlerDeps, id: string): string | null {
  const view = deps.lanes.streams.snapshot(id)
  if (!view?.ok) return null
  const { pending, messages } = view.snapshot
  const event = pending.findLast((e) => e.type === 'message_end' && e.message.role === 'assistant')
  const message =
    event?.type === 'message_end' ? event.message : messages.findLast((m) => m.role === 'assistant')
  if (message?.role !== 'assistant') return null
  let excerpt = ''
  for (const block of message.content) {
    if (block.type !== 'text') continue
    excerpt += (excerpt ? ' ' : '') + block.text.slice(0, SUMMARY_BYTES + 1)
    if (excerpt.length > SUMMARY_BYTES) break
  }
  return clipBytes(excerpt.replace(/\s+/g, ' ').trim(), SUMMARY_BYTES) || null
}

async function waitLane(deps: DaemonHandlerDeps, args: WaitArgs, c: OpHandlerContext) {
  const id = laneId(deps, c)
  const { state, reason } = await waitForActivity(deps, id, args, c.signal)
  const summary = assistantExcerpt(deps, id)
  const status = `Lane is ${state} (${reason}).`
  return {
    text: summary ? `${status}\nLast assistant message (excerpt): ${summary}` : status,
    auditText: status,
    data: { state, reason, summary },
  }
}

export function laneCoordinationHandlers(deps: DaemonHandlerDeps) {
  return {
    'lane.message': op<MessageArgs>((a, c) => messageLane(deps, a, c)),
    'lane.wait': op<WaitArgs>((a, c) => waitLane(deps, a, c)),
  }
}
