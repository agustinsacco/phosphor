import { randomUUID } from 'node:crypto'
import { parseClientFrame, type LaneOp } from '@phosphor/shared/host-protocol'
import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import type { OpHandlerContext, OpPrincipal } from '@phosphor/session-runtime/ops/types'
import type { LaneCommandClient, LaneCommandPorts } from '../../lanes/commands/state'
import { hasCaps, type DaemonLanes } from '../binding'
import { laneCall as featureCall, refusal, unservedCall } from './lane-target'
import { laneIdOf } from '../lane-ref'
import type { DaemonHandlerDeps } from './index'

export interface LaneHandlerPorts {
  daemonLanes: DaemonLanes
  selfIds(): readonly string[]
  recordCreator(laneId: string, principal: OpPrincipal): void
  management?: Pick<LaneCommandPorts, 'archives' | 'deleteLane'> & {
    stopLane(id: string, allowed: () => boolean): Promise<void>
    resumeLane: LaneCommandPorts['resumeLane']
    admitsResume(id: string): boolean
  }
}

export function laneId(deps: LaneHandlerPorts, c: OpHandlerContext) {
  const id = c.lane && laneIdOf(c.lane.ref, deps.selfIds())
  if (!id) throw new OpRefusal('bad-request', 'No lane on this machine.')
  return id
}

/** Refuses a call the principal could not make on its own connection. */
export function requireCall(deps: DaemonHandlerDeps, method: string, c: OpHandlerContext) {
  const capability = deps.lanes.calls.capabilityFor(method)
  if (!capability) throw unservedCall(method)
  if (
    c.principal.kind === 'surface' &&
    (!hasCaps(c.principal) || !c.principal.caps.includes(capability))
  )
    throw new OpRefusal('forbidden', `This connection cannot call ${method}.`)
  c.signal.throwIfAborted()
}

export async function laneCall(
  deps: DaemonHandlerDeps,
  method: string,
  params: unknown,
  c: OpHandlerContext,
) {
  requireCall(deps, method, c)
  return featureCall(deps.lanes, method, params, c.signal)
}

/** Use the real queue and fence for creation/initial prompt. Never act as an existing controller. */
export function commandClient(c: OpHandlerContext): LaneCommandClient {
  const p = c.principal
  return {
    id: p.kind === 'surface' ? p.clientId : randomUUID(),
    label: p.kind === 'surface' ? p.label : 'Phosphor agent',
    origin: p.kind === 'agent' ? 'local' : p.kind,
    caps: ['sessions.control'],
    currentCaps: () => (c.signal.aborted ? [] : ['sessions.control']),
  }
}
export async function laneCommand(
  deps: DaemonHandlerDeps,
  client: LaneCommandClient,
  op: LaneOp,
  target?: { laneId: string; fence?: number },
) {
  const frame = { type: 'command' as const, requestId: randomUUID(), op, ...target }
  const parsed = parseClientFrame(JSON.stringify(frame))
  if (!parsed.ok || parsed.frame.type !== 'command')
    throw new OpRefusal('bad-request', `Invalid ${op.type} request.`)
  await deps.lanes.commands.submit(client, parsed.frame)
  const receipt = deps.store.getReceipt(frame.requestId, client.id)
  if (receipt?.status !== 'done') {
    const reason = receipt?.status === 'rejected' ? receipt.code : 'unavailable'
    throw refusal(
      reason === 'unavailable' ? 'internal' : reason,
      `${op.type}: ${receipt?.status === 'failed' ? receipt.error.message : reason}.`,
    )
  }
  return receipt
}
