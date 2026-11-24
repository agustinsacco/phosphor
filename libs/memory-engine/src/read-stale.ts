/**
 * `saveRead`'s refusal when Brain's knowledge moved after the read was reconciled. It is matched
 * by message, so it holds wherever the store runs; the runtime reconciles again and retries.
 */
export const BRAIN_READ_STALE = 'Brain changed after this read was reconciled.'
export function isBrainReadStale(error: unknown): boolean {
  return error instanceof Error && error.message === BRAIN_READ_STALE
}
