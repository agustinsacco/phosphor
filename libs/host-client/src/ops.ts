import {
  OPS_RUN,
  parseOpsRunRequest,
  parseOpsRunResult,
  type OpsRunRequest,
  type OpsRunResult,
} from '@phosphor/shared/host-protocol-ops'
import { LANE_WAIT_DEADLINE_MS } from '@phosphor/shared/ops'
import type { OpsChangedEvent } from '@phosphor/shared/ipc'
import type { createHostConnection } from './connection'
import { REMOTE_UNAVAILABLE } from './lane-ops'

type Connection = Pick<ReturnType<typeof createHostConnection>, 'send' | 'call'>

/** What a machine without `ops.run` answers, as a surface shows it. */
export const OPS_HOST_TOO_OLD = "That machine's Phosphor is too old for this. Update it first."
export const OPS_UNCONFIRMED =
  'The machine did not confirm the change. Check it before you try again.'
export const OPS_UNREADABLE = 'The machine answered with something Phosphor cannot read.'

const tooOld: OpsRunResult = { status: 'denied', code: 'unsupported', text: OPS_HOST_TOO_OLD }

function answer(data: unknown): OpsRunResult {
  const result = parseOpsRunResult(data)
  if (!result) throw new Error(OPS_UNREADABLE)
  return result
}

/**
 * One catalog op on one connected machine. `write` comes from the op's catalog
 * tier (anything but `read`): a write is an unfenced command with a receipt, a
 * read is a call. An older Host answers `unsupported` on either path, a
 * rejected receipt or a frame-level call error, and both read as `tooOld`.
 * Every other transport failure throws; a write is never resent.
 */
export async function opsRun(
  connection: Connection,
  request: OpsRunRequest,
  options: { readonly write: boolean },
): Promise<OpsRunResult> {
  const parsed = parseOpsRunRequest(request)
  if (!parsed) throw new Error('Invalid agent op request.')
  if (!options.write) {
    const result = await (parsed.op === 'lane.wait'
      ? connection.call(OPS_RUN, parsed, LANE_WAIT_DEADLINE_MS + 2000)
      : connection.call(OPS_RUN, parsed))
    if (result.ok) return answer(result.data)
    if (result.error.code === 'unsupported') return tooOld
    throw new Error(result.error.message)
  }
  const receipt = await connection.send({ type: OPS_RUN, ...parsed })
  if (receipt.status === 'done') return answer(receipt.data)
  if (receipt.status === 'rejected' && receipt.code === 'unsupported') return tooOld
  if (receipt.status === 'failed') throw new Error(receipt.error.message)
  if (receipt.status === 'unknown') throw new Error(OPS_UNCONFIRMED)
  throw new Error(REMOTE_UNAVAILABLE)
}

/** Signature only; U1 owns the synthesis (own completions, lane settle events, a 15 s timer). */
export type WatchOps = (listener: (event: OpsChangedEvent) => void) => () => void
