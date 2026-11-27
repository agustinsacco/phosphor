import { HOST_RELEASE_VERSION_PATTERN } from './host-release'
import { record } from './host-protocol/primitives'

/** An update's outcome, which the updater keeps in `update-result.json` for 24 hours. */
export interface MachineUpdateResult {
  readonly from: string
  readonly to: string
  readonly outcome: 'updated' | 'rolled-back' | 'failed'
  readonly at: string
}

/**
 * `machine.status` `data.update`: what a Host knows about its own updates.
 * Additive inside the op's untyped data; a Host before the self-check sends
 * only `pauseControl`, which reads as no report.
 */
export interface MachineUpdateReport {
  /** False on a source install, which never checks and cannot update itself. */
  readonly supported: boolean
  /** The newest signed release, when it is newer than the installed one. */
  readonly available?: string
  /** ISO time of the last successful check of the signed manifest. */
  readonly checkedAt?: string
  /** This Host serves `service.pause`. */
  readonly pauseControl?: true
  readonly last?: MachineUpdateResult
}

const OUTCOMES: readonly MachineUpdateResult['outcome'][] = ['updated', 'rolled-back', 'failed']
const version = (value: unknown): value is string =>
  typeof value === 'string' && HOST_RELEASE_VERSION_PATTERN.test(value)
const time = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))

function parseResult(value: unknown): MachineUpdateResult | undefined {
  if (!record(value)) return undefined
  const { from, to, outcome, at } = value
  return version(from) && version(to) && OUTCOMES.some((o) => o === outcome) && time(at)
    ? { from, to, outcome: outcome as MachineUpdateResult['outcome'], at }
    : undefined
}

/** Reads `data.update`; a malformed optional field is dropped, not the report. */
export function parseMachineUpdateReport(value: unknown): MachineUpdateReport | undefined {
  if (!record(value) || typeof value.supported !== 'boolean') return undefined
  const last = parseResult(value.last)
  return {
    supported: value.supported,
    ...(version(value.available) ? { available: value.available } : {}),
    ...(time(value.checkedAt) ? { checkedAt: value.checkedAt } : {}),
    ...(value.pauseControl === true ? { pauseControl: true as const } : {}),
    ...(last ? { last } : {}),
  }
}
