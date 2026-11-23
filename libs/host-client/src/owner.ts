import {
  parseOwnerParams,
  type OwnerCalls,
  type OwnerMethod,
} from '@phosphor/shared/host-protocol-owner'
import type { CallErrorCode } from '@phosphor/shared/host-protocol'
import type { createHostConnection } from './connection'

type Connection = Pick<ReturnType<typeof createHostConnection>, 'call'>

/** The daemon refused an owner call; `code` says why (`unsupported` from an older one). */
export class OwnerCallError extends Error {
  readonly code: CallErrorCode

  constructor(code: CallErrorCode, message: string) {
    super(message)
    this.name = 'OwnerCallError'
    this.code = code
  }
}

/**
 * One owner call on this machine's own socket. Params are checked before they
 * are sent; the result is typed, not parsed, because only the local daemon
 * answers these. It rides the connection's 30 s call deadline, shorter than the
 * daemon's `OWNER_LIMITS.callAnswerMs`: a longer call reads as `internal`.
 */
export async function ownerCall<M extends OwnerMethod>(
  connection: Connection,
  method: M,
  params: OwnerCalls[M]['params'],
): Promise<OwnerCalls[M]['result']> {
  const parsed = parseOwnerParams(method, params)
  if (parsed === null) throw new Error(`Invalid ${method} params.`)
  const result = await connection.call(method, parsed)
  if (!result.ok) throw new OwnerCallError(result.error.code, result.error.message)
  return result.data as OwnerCalls[M]['result']
}
