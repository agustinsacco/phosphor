/**
 * Which thinking levels a given model actually supports.
 *
 * Mirrors pi's `getSupportedThinkingLevels()` / `clampThinkingLevel()` from
 * @earendil-works/pi-ai (dist/models.js, verified against pi 0.84.1). Phosphor
 * never imports pi's code, so the algorithm is duplicated here and pinned by
 * unit tests — same contract as `shared/rpc.ts`.
 *
 * Why this exists: both pickers used to render one hardcoded six-item list
 * (`off…xhigh`) for every reasoning model. That list is correct for 3.2% of
 * pi's 1220 catalogued model records. The two failure modes it produced were
 * both silent:
 *
 *   - Offering a level the model lacks. Kimi K2.5 has `thinkingLevelMap: null`,
 *     so `xhigh` is unsupported; pi's `setThinkingLevel` clamps it to `high`
 *     without erroring. The chip then displayed "Xhigh" while the model ran at
 *     `high` — Phosphor reporting a setting the agent was not using.
 *   - Hiding `max` entirely. pi has seven levels; Phosphor's union had six, so
 *     `max`-capable models (98 records) could not reach their top level at all.
 *
 * A live session should prefer pi's own answer over this
 * (`get_available_thinking_levels`); this module is what makes the *home*
 * picker — which has no session to ask — agree with it rather than guess.
 */
import type { ThinkingLevel, ThinkingLevelMap } from './rpc'

/**
 * Every level pi knows, in ascending order of effort.
 * Order is load-bearing: clamping walks this sequence.
 */
export const ALL_THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

/** The subset of a model needed to decide its levels. */
export interface ThinkingCapableModel {
  reasoning: boolean
  thinkingLevelMap?: ThinkingLevelMap | null
}

/**
 * Levels `model` supports, ascending.
 *
 * Three rules, all from pi:
 *   - A non-reasoning model supports only `off`.
 *   - `null` in the map marks a level explicitly unsupported.
 *   - `xhigh`/`max` are opt-in: absent from the map means unsupported, whereas
 *     for `off…high` absent means "use the provider default", i.e. supported.
 */
export function supportedThinkingLevels(model: ThinkingCapableModel): ThinkingLevel[] {
  if (!model.reasoning) return ['off']
  return ALL_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level]
    if (mapped === null) return false
    if (level === 'xhigh' || level === 'max') return mapped !== undefined
    return true
  })
}

/**
 * The level pi will actually use if asked for `level`.
 *
 * Prefers the next level *up* from the request, then falls back downward —
 * matching pi so Phosphor can predict the clamp instead of misreporting it.
 */
export function clampThinkingLevel(
  model: ThinkingCapableModel,
  level: ThinkingLevel,
): ThinkingLevel {
  const available = supportedThinkingLevels(model)
  if (available.includes(level)) return level

  const requested = ALL_THINKING_LEVELS.indexOf(level)
  if (requested === -1) return available[0] ?? 'off'

  for (let i = requested; i < ALL_THINKING_LEVELS.length; i++) {
    const candidate = ALL_THINKING_LEVELS[i]!
    if (available.includes(candidate)) return candidate
  }
  for (let i = requested - 1; i >= 0; i--) {
    const candidate = ALL_THINKING_LEVELS[i]!
    if (available.includes(candidate)) return candidate
  }
  return available[0] ?? 'off'
}

/**
 * Whether a thinking chip is worth showing.
 *
 * `reasoning` alone is not enough: a model whose only level is `off` has
 * nothing to choose between, and a chip reading "No thinking" that opens a
 * one-item menu is noise.
 */
export function hasThinkingChoice(model: ThinkingCapableModel): boolean {
  return supportedThinkingLevels(model).length > 1
}
