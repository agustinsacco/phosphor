/**
 * How one query term hits one field of a model: the text-matching tiers under
 * `modelSearch`. Pure, with no notion of models, providers or queries.
 */

/** One searchable field, pre-split. `weight` scales every tier's score. */
export interface MatchField {
  tokens: string[]
  squashed: string
  weight: number
}

const SEPARATORS = /[^a-z0-9]+/

/** Lowercase, split on every non-alphanumeric run. `us.claude-opus-5` → us, claude, opus, 5 */
export function tokenize(value: string): string[] {
  return value.toLowerCase().split(SEPARATORS).filter(Boolean)
}

/** Lowercase with every separator removed. `claude-opus-5` → `claudeopus5` */
export function squash(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * How well one term hits one field, 0 when it misses.
 *
 * The tiers are ordered by how much intent each implies: typing a whole token
 * is the strongest signal, a prefix next, and a subsequence — which will match
 * almost anything given a long enough id — is capped low enough that it can
 * never outrank a real hit on another model.
 */
export function scoreField(term: string, termSquashed: string, field: MatchField): number {
  // Short terms match only at a boundary. `us` inside `cla-ude-op[us]-5` is
  // noise, and letting it through made `id:us.` return the whole Opus family
  // instead of the one US profile the user asked for. Two characters is the
  // threshold because every real short query (`v2`, `4o`, `5`) is a whole
  // token or a prefix, never a fragment buried mid-word.
  const infix = termSquashed.length >= MIN_INFIX_LENGTH

  let best = 0
  for (const token of field.tokens) {
    if (token === term) {
      best = 100
      break
    }
    if (token.startsWith(term)) best = Math.max(best, 78)
    else if (infix && token.includes(term)) best = Math.max(best, 52)
  }
  if (best < 100) best = Math.max(best, scoreTokenRun(term, field.tokens))
  if (best < 100 && termSquashed) {
    if (field.squashed.startsWith(termSquashed)) best = Math.max(best, 66)
    else if (infix && field.squashed.includes(termSquashed)) best = Math.max(best, 44)
  }
  if (best === 0 && termSquashed.length >= MIN_FUZZY_LENGTH) {
    const density = subsequenceDensity(termSquashed, field.squashed)
    if (density !== null) best = 20 * density
  }
  return best * field.weight
}

/**
 * A term with separators inside (`5.2`, `4-7`) against a run of consecutive
 * tokens, the last of which may be a prefix. Without this a dotted version
 * squashes to two characters, under the infix floor, and matches nothing.
 */
function scoreTokenRun(term: string, tokens: readonly string[]): number {
  const parts = tokenize(term)
  if (parts.length < 2) return 0
  const last = parts.length - 1
  let best = 0
  for (let start = 0; start + last < tokens.length; start++) {
    const run = parts.every((part, i) => {
      const token = tokens[start + i] as string
      return i === last ? token.startsWith(part) : token === part
    })
    if (run) best = Math.max(best, tokens[start + last] === parts[last] ? 100 : 78)
  }
  return best
}

/** Below this, a term must land on a token boundary rather than mid-word. */
const MIN_INFIX_LENGTH = 3
/** Below this, a subsequence hit is coincidence — almost any id contains it. */
const MIN_FUZZY_LENGTH = 3

/**
 * Longest run of consecutive query characters, over query length, or null when
 * `query` is not a subsequence of `target` at all. Rewards `clop` → **cl**aude
 * **op**us over four characters scattered across an ARN.
 */
function subsequenceDensity(query: string, target: string): number | null {
  if (!query) return 1
  let qi = 0
  let streak = 0
  let longest = 0
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) {
      qi++
      streak++
      if (streak > longest) longest = streak
    } else {
      streak = 0
    }
  }
  if (qi < query.length) return null
  return longest / query.length
}
