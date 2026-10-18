import type { Execution } from './state'

/**
 * A handler either did not match the op, or handled it: answered it synchronously
 * (no execution) or started an execution the queue tracks.
 */
export type Routed = { handled: false } | { handled: true; execution?: Execution }
export const NOT_MATCHED: Routed = { handled: false }
export const handled = (execution?: Execution): Routed => ({ handled: true, execution })
