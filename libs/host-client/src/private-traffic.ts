import { isBrainSurfaceOp } from '@phosphor/shared/host-brain'
import type { ClientFrame, HostFrame } from '@phosphor/shared/host-protocol'
import type { createRequests } from './requests'

/** Brain payloads and answers with no known request are not diagnostic traffic. */
export function omitPrivateTraffic(
  frame: ClientFrame | HostFrame,
  requests: ReturnType<typeof createRequests>,
): boolean {
  if (frame.type === 'command') return frame.op.type === 'ops.run' && isBrainSurfaceOp(frame.op.op)
  if (frame.type === 'call')
    return (
      frame.method === 'ops.run' &&
      !!frame.params &&
      typeof frame.params === 'object' &&
      'op' in frame.params &&
      isBrainSurfaceOp(frame.params.op)
    )
  if (frame.type === 'result') return !requests.publicResult(frame.id)
  if (frame.type === 'receipt') return !requests.publicReceipt(frame.receipt.requestId)
  return false
}
