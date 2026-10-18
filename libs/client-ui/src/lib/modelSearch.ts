/**
 * Lexical search, family grouping and match highlighting for the model picker.
 *
 * The catalogue is not a list of models — it is a list of *routes to* models.
 * "Claude Opus 5" can arrive five ways at once: pi's native `anthropic`
 * provider, the Claude Code CLI provider, and three Bedrock inference
 * profiles (`us.` / `eu.` / `global.`). A subsequence matcher over one
 * concatenated `name id provider` string, which is what this used to be,
 * fails that catalogue in three specific ways:
 *
 *   1. **Term order leaks into the result.** `"opus bedrock"` matched and
 *      `"bedrock opus"` did not, because a subsequence must appear in query
 *      order. Users do not know the field order and should not have to.
 *   2. **Separators are load-bearing.** `"opus-5"`, `"opus 5"` and `"opus5"`
 *      are the same intent and matched three different sets.
 *   3. **Ranking ignores where the hit landed.** A stray character run deep
 *      inside an ARN-shaped id outscored an exact name match.
 *
 * So: parse the query into terms, require *every* term to match somewhere
 * (AND, order-free), score each term against each field by how good the hit
 * is — exact token, token prefix, separator-insensitive prefix, substring,
 * then subsequence as a last resort — and weight fields so a name hit beats
 * an id hit beats a provider hit.
 *
 * Two things exist here that a generic fuzzy matcher cannot supply:
 *
 * - **Aliases.** Nobody types `amazon-bedrock`; they type `aws` or `bedrock`.
 *   Nobody types `pi-claude-cli`; they type `claude code`. These are search-only
 *   synonyms — the UI always shows the real provider id, so no alias can make
 *   the menu claim something untrue about what will serve the session.
 * - **Family keys.** `claude-opus-5`, `anthropic.claude-opus-5` and
 *   `us.anthropic.claude-opus-5` are one model reachable three ways. Collapsing
 *   them to a family lets the menu ask "which Opus 5?" once instead of
 *   scattering five near-identical rows through a flat ranked list.
 *
 * Everything in this module is pure and independent of React so it can be
 * tested directly; `ModelMenu` is the only consumer.
 */

import { baseModelId } from './modelAvailability'

/** The minimum a model must carry to be searched. */
export interface SearchableModel {
  id: string
  name: string
  provider: string
  /** Optional metadata, used by `is:` filters when the catalogue supplies it. */
  reasoning?: boolean
  contextWindow?: number
}

/** Stable identity of one catalogue entry: a provider *and* an id. */
export function modelKey(model: SearchableModel): string {
  return `${model.provider}/${model.id}`
}

// ---------------------------------------------------------------- normalizing

const SEPARATORS = /[^a-z0-9]+/

/** Lowercase, split on every non-alphanumeric run. `us.claude-opus-5` → us, claude, opus, 5 */
export function tokenize(value: string): string[] {
  return value.toLowerCase().split(SEPARATORS).filter(Boolean)
}

/** Lowercase with every separator removed. `claude-opus-5` → `claudeopus5` */
export function squash(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

// ------------------------------------------------------------------- aliases

/**
 * Search-only synonyms per provider id.
 *
 * These never reach the rendered row — the menu prints `model.provider`
 * verbatim — so an entry here can only ever widen what a query finds, never
 * misreport what is serving a session.
 */
const PROVIDER_ALIASES: Record<string, string[]> = {
  anthropic: ['claude'],
  'amazon-bedrock': ['bedrock', 'aws', 'amazon'],
  bedrock: ['aws', 'amazon'],
  'claude-cli': ['claude', 'claude code', 'claudecode', 'cli'],
  'pi-claude-cli': ['claude', 'claude code', 'claudecode', 'cli'],
  'claude-code': ['claude', 'cli'],
  openai: ['gpt', 'chatgpt'],
  azure: ['openai', 'gpt', 'microsoft'],
  google: ['gemini'],
  vertex: ['google', 'gemini', 'gcp'],
  xai: ['grok'],
  zai: ['glm'],
  openrouter: ['router'],
  groq: [],
  cerebras: [],
  mistral: [],
  fireworks: [],
  together: [],
  baseten: [],
}

/**
 * Aliases for a provider, table first and then a couple of shape-based
 * guesses so a provider package nobody has enumerated still behaves.
 */
export function providerAliases(provider: string): string[] {
  const known = PROVIDER_ALIASES[provider.toLowerCase()]
  if (known) return known
  const aliases: string[] = []
  const lower = provider.toLowerCase()
  if (lower.includes('claude')) aliases.push('claude', 'anthropic')
  if (lower.includes('bedrock')) aliases.push('aws', 'amazon')
  if (lower.includes('gemini')) aliases.push('google')
  if (lower.includes('gpt')) aliases.push('openai')
  if (lower.startsWith('local') || lower.includes('ollama') || lower.includes('lmstudio')) {
    aliases.push('local', 'offline')
  }
  return aliases
}

// ------------------------------------------------------------------ families

/** Vendor namespaces that prefix an id without identifying the model. */
const VENDOR_PREFIX =
  /^(anthropic|amazon|meta|mistral|cohere|ai21|deepseek|qwen|alibaba|google|openai|writer|stability|luma|twelvelabs)\./

/**
 * Suffixes that distinguish a *build* of a model rather than the model:
 * a release date (`-20250929`), a Bedrock version (`-v1:0`, `:0`), or a
 * channel word. Two entries that differ only here are the same family.
 */
const BUILD_SUFFIX = /(?:[-_](?:latest|preview|exp|experimental|beta))?(?:[-_]v\d+)?(?::\d+)?$/
const DATE_SUFFIX = /[-_]\d{6,8}$/

/**
 * Collapse one catalogue entry to the model it actually reaches.
 *
 * `claude-opus-5`, `anthropic.claude-opus-5` and `us.anthropic.claude-opus-5`
 * all key to `claudeopus5`, so the picker can show "Claude Opus 5" once with
 * its five routes underneath instead of five rows that read the same.
 *
 * Deliberately id-only: names differ across providers for the same model
 * ("Claude Opus 5" vs "Opus 5" vs "Claude Opus 5 (US)"), so keying on the
 * name would split families that ids join.
 */
export function familyKey(model: SearchableModel): string {
  let id = baseModelId(model.id)
  id = id.replace(VENDOR_PREFIX, '')
  id = id.replace(DATE_SUFFIX, '')
  id = id.replace(BUILD_SUFFIX, '')
  const key = squash(id)
  // A model whose id is *only* a vendor prefix and a build stamp has nothing
  // left to key on; fall back to the full id so it stays its own family
  // rather than joining every other degenerate entry.
  return key || squash(model.id)
}

/** `Claude Opus 5 (US)` → `Claude Opus 5`. Region suffixes are routing, not identity. */
export function stripRegionSuffix(name: string): string {
  return name.replace(/\s*\((?:us|usa|eu|apac|ap|global|cross[- ]region)[^)]*\)\s*$/i, '').trim()
}

/**
 * One label for a family. The most common region-stripped name wins; ties go
 * to the shortest, so "Claude Opus 5" beats "Claude Opus 5 v2 (preview build)".
 */
export function familyLabel(models: readonly SearchableModel[]): string {
  const counts = new Map<string, number>()
  for (const model of models) {
    const label = stripRegionSuffix(model.name || model.id)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  let best = ''
  let bestCount = -1
  for (const [label, count] of counts) {
    if (count > bestCount || (count === bestCount && label.length < best.length)) {
      best = label
      bestCount = count
    }
  }
  return best
}

// -------------------------------------------------------------- query parsing

/** Fields a `field:value` term can be pinned to. */
export type QueryField = 'name' | 'id' | 'provider'

/** Flags `is:` understands. Unknown flags match nothing, loudly and predictably. */
export type QueryFlag = 'reasoning' | 'available' | 'unavailable' | 'starred' | 'recent'

export interface QueryTerm {
  /** The literal text to match, lowercased. Empty for flag terms. */
  value: string
  /** Restrict this term to one field; null means "any field". */
  field: QueryField | null
  /** Set when the term was `is:<flag>`. */
  flag: QueryFlag | string | null
  /** `-term` / `!term`: the model must NOT match. */
  negated: boolean
}

export interface ParsedQuery {
  terms: QueryTerm[]
  /** Bare (unqualified, non-negated) text, for highlighting. */
  highlightTerms: string[]
}

const FIELD_PREFIXES: Record<string, QueryField> = {
  name: 'name',
  n: 'name',
  id: 'id',
  model: 'id',
  provider: 'provider',
  p: 'provider',
  from: 'provider',
  via: 'provider',
}

/**
 * Split a raw query into terms.
 *
 * Whitespace separates terms; `"quoted phrases"` keep their spaces so
 * `provider:"claude code"` and `"opus 5"` work. A leading `-` or `!` negates.
 * `field:value` pins a term; `is:flag` filters on metadata. Anything that
 * merely *contains* a colon (`amazon.nova-pro-v1:0`) is left alone — only the
 * known prefixes above are treated as qualifiers.
 */
export function parseQuery(raw: string): ParsedQuery {
  const terms: QueryTerm[] = []
  const highlightTerms: string[] = []
  for (const chunk of splitTerms(raw)) {
    let text = chunk
    let negated = false
    if (text.startsWith('-') || text.startsWith('!')) {
      negated = true
      text = text.slice(1)
    }
    if (!text) continue

    const colon = text.indexOf(':')
    if (colon > 0) {
      const head = text.slice(0, colon).toLowerCase()
      const tail = unquote(text.slice(colon + 1))
      if (head === 'is' && tail) {
        terms.push({ value: '', field: null, flag: tail.toLowerCase(), negated })
        continue
      }
      const field = FIELD_PREFIXES[head]
      if (field && tail) {
        terms.push({ value: tail.toLowerCase(), field, flag: null, negated })
        continue
      }
    }

    const value = unquote(text).toLowerCase()
    if (!value) continue
    terms.push({ value, field: null, flag: null, negated })
    if (!negated) highlightTerms.push(value)
  }
  return { terms, highlightTerms }
}

/** Whitespace split that keeps double-quoted runs together. */
function splitTerms(raw: string): string[] {
  const out: string[] = []
  let current = ''
  let quoted = false
  for (const char of raw) {
    if (char === '"') {
      quoted = !quoted
      current += char
      continue
    }
    if (!quoted && /\s/.test(char)) {
      if (current) out.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current) out.push(current)
  return out
}

function unquote(value: string): string {
  return value.replace(/"/g, '').trim()
}

// -------------------------------------------------------------------- scoring

interface IndexedField {
  field: QueryField
  tokens: string[]
  squashed: string
  weight: number
}

interface IndexedModel<T extends SearchableModel> {
  model: T
  key: string
  familyKey: string
  fields: IndexedField[]
}

/**
 * Field weights. A name hit is what the user meant; an id hit is usually the
 * same thing spelled machine-side; a provider hit is a filter, not an
 * identification, so it must not let `provider` swamp the ranking when a term
 * happens to appear in both.
 */
const WEIGHTS = { name: 1, id: 0.85, provider: 0.62, alias: 0.6 } as const

function indexModel<T extends SearchableModel>(model: T): IndexedModel<T> {
  const aliasText = providerAliases(model.provider).join(' ')
  const fields: IndexedField[] = [
    {
      field: 'name',
      tokens: tokenize(model.name),
      squashed: squash(model.name),
      weight: WEIGHTS.name,
    },
    { field: 'id', tokens: tokenize(model.id), squashed: squash(model.id), weight: WEIGHTS.id },
    {
      field: 'provider',
      tokens: tokenize(model.provider),
      squashed: squash(model.provider),
      weight: WEIGHTS.provider,
    },
  ]
  if (aliasText) {
    // Aliases answer for the provider, so a `provider:` qualifier consults
    // them too — `provider:aws` has to find `amazon-bedrock`.
    fields.push({
      field: 'provider',
      tokens: tokenize(aliasText),
      squashed: squash(aliasText),
      weight: WEIGHTS.alias,
    })
  }
  return { model, key: modelKey(model), familyKey: familyKey(model), fields }
}

/**
 * How well one term hits one field, 0 when it misses.
 *
 * The tiers are ordered by how much intent each implies: typing a whole token
 * is the strongest signal, a prefix next, and a subsequence — which will match
 * almost anything given a long enough id — is capped low enough that it can
 * never outrank a real hit on another model.
 */
function scoreField(term: string, termSquashed: string, field: IndexedField): number {
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

/** Metadata the `is:` flags consult; all optional. */
export interface SearchContext {
  starred?: ReadonlySet<string>
  recent?: ReadonlySet<string>
  unavailable?: ReadonlySet<string>
}

function matchesFlag<T extends SearchableModel>(
  flag: string,
  indexed: IndexedModel<T>,
  context: SearchContext,
): boolean {
  switch (flag) {
    case 'reasoning':
    case 'thinking':
      return indexed.model.reasoning === true
    case 'available':
      return !context.unavailable?.has(indexed.key)
    case 'unavailable':
    case 'blocked':
      return context.unavailable?.has(indexed.key) === true
    case 'starred':
    case 'star':
    case 'pinned':
    case 'favorite':
    case 'favourite':
      return context.starred?.has(indexed.key) === true
    case 'recent':
      return context.recent?.has(indexed.key) === true
    default:
      // An unknown flag is a typo, not a wildcard. Matching nothing makes that
      // visible immediately instead of silently returning the whole catalogue.
      return false
  }
}

export interface ModelSearchResult<T extends SearchableModel> {
  model: T
  key: string
  familyKey: string
  score: number
}

/**
 * Rank `models` against `query`. Every term must match (AND), in any order.
 * An empty query returns every model in input order with score 0.
 */
export function searchModels<T extends SearchableModel>(
  query: string,
  models: readonly T[],
  context: SearchContext = {},
): ModelSearchResult<T>[] {
  const parsed = parseQuery(query)
  const indexed = models.map(indexModel)
  if (parsed.terms.length === 0) {
    return indexed.map((entry) => ({
      model: entry.model,
      key: entry.key,
      familyKey: entry.familyKey,
      score: 0,
    }))
  }

  const results: ModelSearchResult<T>[] = []
  for (const entry of indexed) {
    const score = scoreModel(parsed, entry, context)
    if (score === null) continue
    results.push({ model: entry.model, key: entry.key, familyKey: entry.familyKey, score })
  }

  results.sort(
    (a, b) =>
      b.score - a.score ||
      a.model.id.length - b.model.id.length ||
      a.model.name.localeCompare(b.model.name) ||
      a.key.localeCompare(b.key),
  )
  return results
}

function scoreModel<T extends SearchableModel>(
  parsed: ParsedQuery,
  entry: IndexedModel<T>,
  context: SearchContext,
): number | null {
  let total = 0
  for (const term of parsed.terms) {
    let hit: number

    if (term.flag !== null) {
      hit = matchesFlag(term.flag, entry, context) ? 100 : 0
    } else {
      const termSquashed = squash(term.value)
      hit = 0
      for (const field of entry.fields) {
        if (term.field && field.field !== term.field) continue
        const score = scoreField(term.value, termSquashed, field)
        if (score > hit) hit = score
      }
    }

    if (term.negated) {
      if (hit > 0) return null
      continue
    }
    if (hit <= 0) return null
    total += hit
  }

  // The whole query as one string against the name: "opus 5" should put the
  // Opus 5 family above a model whose id merely contains both fragments.
  const whole = squash(parsed.highlightTerms.join(''))
  if (whole) {
    const name = entry.fields[0]!.squashed
    if (name === whole) total += 220
    else if (name.startsWith(whole)) total += 140
    else if (name.includes(whole)) total += 60
  }
  return total
}

// --------------------------------------------------------------- highlighting

export interface HighlightRange {
  start: number
  end: number
}

/**
 * Character ranges in `text` to emphasise for `query`.
 *
 * Substring hits only — a subsequence hit would scatter single highlighted
 * letters across an id and read as corruption rather than as a match. Each
 * bare term is matched whole, and also by its separator-split parts, so
 * `opus-5` lights up both halves of `Claude Opus 5`.
 */
export function highlightRanges(text: string, query: string): HighlightRange[] {
  const { highlightTerms } = parseQuery(query)
  if (highlightTerms.length === 0 || !text) return []
  const needles = new Set<string>()
  for (const term of highlightTerms) {
    needles.add(term)
    for (const part of tokenize(term)) needles.add(part)
  }

  const lower = text.toLowerCase()
  const ranges: HighlightRange[] = []
  for (const needle of needles) {
    if (!needle) continue
    let from = 0
    for (;;) {
      const at = lower.indexOf(needle, from)
      if (at === -1) break
      ranges.push({ start: at, end: at + needle.length })
      from = at + 1
    }
  }
  return mergeRanges(ranges)
}

function mergeRanges(ranges: HighlightRange[]): HighlightRange[] {
  if (ranges.length === 0) return []
  ranges.sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: HighlightRange[] = [ranges[0]!]
  for (const range of ranges.slice(1)) {
    const last = merged[merged.length - 1]!
    if (range.start <= last.end) last.end = Math.max(last.end, range.end)
    else merged.push({ ...range })
  }
  return merged
}

// ------------------------------------------------------------------- grouping

export type GroupMode = 'family' | 'provider'

export interface ModelGroup<T extends SearchableModel> {
  /** Stable React key: the family key or the provider id. */
  key: string
  /** Header text. Providers are printed verbatim — never prettified. */
  label: string
  items: ModelSearchResult<T>[]
  /** Best member score, for ordering groups by relevance. */
  score: number
}

/**
 * Bucket ranked results.
 *
 * `family` answers "which Opus 5?" — one header, every route under it.
 * `provider` answers "what do I have from whom?" — the shape the menu had
 * before, kept because it is the better read of an unsearched catalogue.
 *
 * With `ordered`, groups and their members follow relevance (search). Without,
 * they are alphabetical (idle), which is stable across keystrokes.
 */
export function groupModels<T extends SearchableModel>(
  results: readonly ModelSearchResult<T>[],
  mode: GroupMode,
  ordered: boolean,
): ModelGroup<T>[] {
  const groups = new Map<string, ModelGroup<T>>()
  for (const result of results) {
    const key = mode === 'family' ? result.familyKey : result.model.provider
    const group = groups.get(key) ?? { key, label: '', items: [], score: -Infinity }
    group.items.push(result)
    group.score = Math.max(group.score, result.score)
    groups.set(key, group)
  }

  const list = [...groups.values()]
  for (const group of list) {
    group.label =
      mode === 'family'
        ? familyLabel(group.items.map((item) => item.model))
        : group.items[0]!.model.provider
    if (!ordered) {
      group.items.sort(
        (a, b) =>
          a.model.provider.localeCompare(b.model.provider) ||
          a.model.name.localeCompare(b.model.name) ||
          a.model.id.localeCompare(b.model.id),
      )
    }
  }

  list.sort(
    ordered
      ? (a, b) => b.score - a.score || a.label.localeCompare(b.label)
      : (a, b) => a.label.localeCompare(b.label),
  )
  return list
}
