/** parseClientFrame: one client frame, accepted as a projection or refused with a reason. */
import { isControlTrace, isUuid } from '../control-api'
import { GRANT_LIMITS } from '../host-grant'
import { parseTerminalInput, parseTerminalSubscribe } from '../host-protocol-terminals'
import { parseCallFrame, parseCommandFrame } from './client-commands'
import { HOST_LIMITS } from './constants'
import type { ClientFrame, ClientFrameParse } from './frames'
import { cursor, frameId, integer, readJson, text } from './primitives'

const bad = (reason = 'frame'): ClientFrameParse => ({ ok: false, reason })
const good = (frame: ClientFrame): ClientFrameParse => ({ ok: true, frame })

/** The one client frame with an exact key set: any other key refuses it. */
function parseAuth(v: Record<string, unknown>): ClientFrameParse {
  if (
    !Object.keys(v).every((key) => ['type', 'grant', 'challenge', 'trace'].includes(key)) ||
    (v.trace !== undefined && !isControlTrace(v.trace)) ||
    !text(v.grant, GRANT_LIMITS.tokenChars) ||
    (v.challenge !== undefined &&
      (typeof v.challenge !== 'string' || !/^[0-9a-f]{64}$/.test(v.challenge)))
  )
    return bad()
  return good({
    type: 'auth',
    grant: v.grant,
    ...(v.challenge !== undefined ? { challenge: v.challenge } : {}),
    ...(v.trace !== undefined ? { trace: v.trace } : {}),
  })
}

/** The terminal topic has its own exact-key parser; lanes and lane are projected here. */
function parseSubscribe(v: Record<string, unknown>): ClientFrameParse {
  if (v.topic === 'terminal') {
    const subscription = parseTerminalSubscribe(v)
    return subscription ? good(subscription) : bad()
  }
  const after = v.after === undefined ? undefined : cursor(v.after)
  if (!frameId(v.id) || after === null || (v.trace !== undefined && !isControlTrace(v.trace)))
    return bad()
  const common = {
    id: v.id,
    ...(after ? { after } : {}),
    ...(v.trace !== undefined ? { trace: v.trace } : {}),
  }
  if (v.topic === 'lanes') return good({ type: 'subscribe', topic: v.topic, ...common })
  if (v.topic === 'lane' && isUuid(v.laneId))
    return good({ type: 'subscribe', topic: v.topic, laneId: v.laneId, ...common })
  return bad()
}

export function parseClientFrame(s: string): ClientFrameParse {
  const parsed = readJson(s, HOST_LIMITS.inboundFrameBytes)
  if (!parsed.ok) return parsed
  const v = parsed.value
  switch (v.type) {
    case 'auth':
      return parseAuth(v)
    case 'terminal.input': {
      const input = parseTerminalInput(v)
      return input ? good(input) : bad()
    }
    case 'subscribe':
      return parseSubscribe(v)
    case 'unsubscribe':
      return frameId(v.id) ? good({ type: v.type, id: v.id }) : bad()
    case 'receipt-status':
      return isUuid(v.requestId) ? good({ type: v.type, requestId: v.requestId }) : bad()
    case 'ping':
      return integer(v.at) ? good({ type: v.type, at: v.at }) : bad()
    case 'command':
      return parseCommandFrame(v)
    case 'call':
      return parseCallFrame(v)
    default:
      return bad('type')
  }
}
