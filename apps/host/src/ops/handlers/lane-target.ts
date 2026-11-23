import type { CallErrorCode, LaneSummary, RejectCode } from '@phosphor/shared/host-protocol'
import type { OpsDenyCode } from '@phosphor/shared/host-protocol-ops'
import type { RpcCommand } from '@phosphor/shared/rpc'
import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import type { LaneFacts, OpHandlerContext } from '@phosphor/session-runtime/ops/types'
import type { McpLaneResult } from '@phosphor/shared/mcp-inspection'
import type { CallOutcome, LaneService } from '../../lanes/service'

/** The lane runtime H4's lane handlers act through, beside the lane service. */
export interface DaemonLaneRuntime {
  /** A lane command through the lane runtime: naming, the model switch and state refresh apply. */
  command(sessionId: string, rpc: RpcCommand): Promise<{ success: boolean; error?: string }>
  /** Inspect or reconnect a connector inside a live lane, under the session service's admission. */
  mcpControl(
    sessionId: string,
    name: string,
    operation: 'inspect' | 'reconnect',
  ): Promise<McpLaneResult>
  summaryFor(laneId: string): LaneSummary | null
  /** Republishes the lane's summary after a store change (pin, marker). */
  publishSummary(laneId: string): void
}

const LANE_ID = /\/lane:([^/]+)$/

/** The lane id in a ref this machine resolved (`host:<id>/lane:<laneId>`). */
export const laneIdOfRef = (ref: string): string | undefined => LANE_ID.exec(ref)?.[1]

/** The lane an op is about, with its id on this machine. */
export function targetLane(ctx: OpHandlerContext): LaneFacts & { readonly laneId: string } {
  const lane = ctx.lane
  const laneId = lane ? laneIdOfRef(lane.ref) : undefined
  if (!lane || !laneId) throw new OpRefusal('bad-request', 'Name a lane on this machine.')
  return { ...lane, laneId }
}

/** The lane's live pi session, or a refusal saying how to get one. */
export function liveSession(ctx: OpHandlerContext, action: string): string {
  const { sessionId } = targetLane(ctx)
  if (!sessionId) throw new OpRefusal('unavailable', `Resume the lane to ${action} it.`)
  return sessionId
}

export function requireRuntime(runtime: DaemonLaneRuntime | undefined): DaemonLaneRuntime {
  if (!runtime) throw new OpRefusal('unavailable', 'Lanes on this machine aren’t running yet.')
  return runtime
}

const DENY: Partial<Record<CallErrorCode | RejectCode, OpsDenyCode>> = {
  'bad-request': 'bad-request',
  // A stale expected revision or an existing path: the request must change, not the machine.
  conflict: 'bad-request',
  forbidden: 'forbidden',
  'too-large': 'too-large',
  busy: 'busy',
  unsupported: 'unsupported',
}

const SAID: Partial<Record<CallErrorCode | RejectCode, string>> = {
  'unknown-lane': 'That lane is unavailable on this machine.',
  'lane-stopped': 'That lane is stopped.',
  conflict: 'The file changed or already exists; read it again first.',
  'too-large': 'The result is too large; narrow the request.',
}

/** A Host refusal in the agent's words. */
export function refusal(code: CallErrorCode | RejectCode, message?: string): OpRefusal {
  return new OpRefusal(DENY[code] ?? 'unavailable', SAID[code] ?? message ?? `Refused: ${code}.`)
}

/** A lane-service call (files, git, GitHub), its failure as an in-band refusal. */
export async function laneCall(
  lanes: Pick<LaneService, 'calls'>,
  method: string,
  params: unknown,
): Promise<unknown> {
  const outcome: CallOutcome = await lanes.calls.call(method, params)
  if (!outcome.ok) throw refusal(outcome.error.code, outcome.error.message)
  return outcome.data
}
