/**
 * Which Bedrock model ids are actually invocable, and why.
 *
 * Amazon Bedrock exposes newer Anthropic models as *inference profiles* only:
 * the bare foundation-model id (`anthropic.claude-fable-5`) cannot be invoked
 * with on-demand throughput, and returns
 *
 *   Invocation of model ID anthropic.claude-fable-5 with on-demand throughput
 *   isn't supported. Retry your request with the ID or ARN of an inference
 *   profile that contains this model.
 *
 * pi's catalogue lists the bare id and the region-prefixed profiles
 * (`us.`/`eu.`/`global.`/…) as sibling entries with no marker distinguishing
 * them, so the bare one reads as a normal choice, sorts first, and is the first
 * fuzzy match for "fable" — a menu item that fails 100% of the time.
 *
 * We do not hardcode a per-model capability table: that data belongs to pi's
 * model store, and a copy here would drift the moment AWS changes a model's
 * requirements. Instead we use the only signal that is self-evident from the
 * catalogue itself — a bare id is unusable when the same catalogue also offers
 * region-prefixed profiles of that same model. That inference is local, needs
 * no maintenance, and degrades to "say nothing" whenever the shape is
 * unfamiliar.
 */

/** Minimal model shape this module reasons about. */
export interface AvailabilityModel {
  id: string
  provider: string
}

/** Region/routing prefixes Bedrock uses for Anthropic inference profiles. */
const PROFILE_PREFIX = /^([a-z]{2}|global)\./

export const BEDROCK_PROVIDER = 'amazon-bedrock'

/**
 * Strip a Bedrock inference-profile prefix, returning the underlying
 * foundation-model id. `global.anthropic.claude-fable-5` → `anthropic.claude-fable-5`.
 * Ids without a recognized prefix are returned unchanged.
 */
export function baseModelId(id: string): string {
  return id.replace(PROFILE_PREFIX, '')
}

/** True when `id` carries a region/routing prefix (i.e. is a profile id). */
export function isProfileId(id: string): boolean {
  return PROFILE_PREFIX.test(id)
}

/**
 * Why a model cannot be selected, or null when it looks fine.
 *
 * The only case we claim is the structural one described above. Everything
 * else — including account-level restrictions like Bedrock's data retention
 * mode — is invisible from the catalogue and only knowable by attempting a
 * call, so it is deliberately NOT guessed at here.
 */
export interface Unavailability {
  reason: 'requires-inference-profile'
  /** Human-readable explanation for the menu. */
  detail: string
  /** Profile ids that do work for this model, for the "use X instead" hint. */
  alternatives: string[]
}

/**
 * Index the catalogue once, then answer per-model.
 *
 * Returns a lookup keyed `provider/id`. Only Bedrock entries are considered;
 * every other provider gets an empty result (no provider-specific guessing
 * leaks into e.g. OpenAI or a local OpenAI-compatible endpoint).
 */
export function unavailableModels(
  models: readonly AvailabilityModel[],
): Map<string, Unavailability> {
  // base foundation id -> profile ids offering it
  const profilesByBase = new Map<string, string[]>()
  for (const model of models) {
    if (model.provider !== BEDROCK_PROVIDER) continue
    if (!isProfileId(model.id)) continue
    const base = baseModelId(model.id)
    const list = profilesByBase.get(base) ?? []
    list.push(model.id)
    profilesByBase.set(base, list)
  }

  const result = new Map<string, Unavailability>()
  for (const model of models) {
    if (model.provider !== BEDROCK_PROVIDER) continue
    if (isProfileId(model.id)) continue
    const alternatives = profilesByBase.get(model.id)
    // A bare id with no profile siblings may well be invocable on-demand
    // (Claude 3.x, Nova, …) — say nothing.
    if (!alternatives || alternatives.length === 0) continue
    result.set(`${model.provider}/${model.id}`, {
      reason: 'requires-inference-profile',
      detail: 'Needs an inference profile — pick a region-prefixed variant.',
      alternatives: [...alternatives].sort(),
    })
  }
  return result
}

/** Key used by {@link unavailableModels}. */
export function availabilityKey(model: AvailabilityModel): string {
  return `${model.provider}/${model.id}`
}
