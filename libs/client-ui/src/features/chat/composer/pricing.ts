import type { Model } from '@shared/rpc'

/**
 * True when a model's catalog carries no cost rates at all — pi then computes
 * every response as $0, which the UI should surface as "no pricing
 * configured" rather than a misleading $0.0000. Custom providers in
 * models.json default to all-zero rates unless the user fills in `cost`.
 */
export function hasNoPricing(model: Model | null | undefined): boolean {
  const cost = model?.cost
  if (!cost) return true
  return (
    (cost.input ?? 0) === 0 &&
    (cost.output ?? 0) === 0 &&
    (cost.cacheRead ?? 0) === 0 &&
    (cost.cacheWrite ?? 0) === 0
  )
}
