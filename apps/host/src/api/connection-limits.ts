import { HOST_LIMITS } from '@phosphor/shared/host-protocol'

const LIMIT_KEYS = [
  'authTimeoutMs',
  'inboundFrameBytes',
  'sendQueueBytes',
  'connectionsPerClient',
  'pingIntervalMs',
  'idleCloseMs',
] as const
export type ConnectionLimits = Partial<Record<(typeof LIMIT_KEYS)[number], number>>

/** Local overrides can tighten transport bounds, never expand the shared ceiling. */
export function connectionLimits(input?: ConnectionLimits) {
  const limits = { ...HOST_LIMITS, ...input }
  for (const name of LIMIT_KEYS)
    if (!Number.isSafeInteger(limits[name]) || limits[name] < 1 || limits[name] > HOST_LIMITS[name])
      throw new Error('Invalid limit')
  return limits
}
