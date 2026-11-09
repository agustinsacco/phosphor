import {
  BRAIN_ENTITY_KINDS,
  BRAIN_MEMORY_TYPES,
  BRAIN_PREDICATES,
  type BrainEntity,
  type BrainEntityKind,
  type BrainEpistemicKind,
  type BrainMemoryType,
  type BrainPredicate,
} from '@phosphor/shared/brain'
import type { RawEntity, RawExtraction, RawMemory } from '@phosphor/memory-engine/types'
import { scrubExcerpt } from './secrets'

export interface ExtractionLimits {
  onCandidate?: (
    candidate: number,
    memory: RawMemory | undefined,
    summary: string,
    reason?: string,
  ) => void
  maxEntities?: number
  maxMemories?: number
  existingEntities?: BrainEntity[]
}
export const fold = (text: string): string =>
  text.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ')
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string')
const nullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string'
const vocabulary = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
  typeof value === 'string'
    ? allowed.find((item) => item === value.trim().toLowerCase())
    : undefined

/** Whole Unicode word phrases, not a substring of another entity's name. */
export function mentions(text: string, label: string): boolean {
  const escaped = fold(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    !!escaped &&
    new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'u').test(fold(text))
  )
}

/** Names are stored, searched and shown to later forks: one holding a secret is dropped. */
const clean = (text: string): boolean => scrubExcerpt(text) === text

function entity(value: unknown): RawEntity | undefined {
  if (
    !record(value) ||
    typeof value.key !== 'string' ||
    !value.key.trim() ||
    typeof value.label !== 'string' ||
    !value.label.trim() ||
    !strings(value.aliases)
  )
    return
  const kind = vocabulary<BrainEntityKind>(value.kind, BRAIN_ENTITY_KINDS)
  if (!kind || !clean(value.label)) return
  return {
    key: value.key.trim(),
    label: value.label.trim(),
    kind,
    aliases: value.aliases.map((v) => v.trim()).filter((v) => v && clean(v)),
  }
}

function memory(
  value: unknown,
  entities: Map<string, { label: string; aliases: string[] }>,
): RawMemory | undefined {
  if (
    !record(value) ||
    typeof value.subject !== 'string' ||
    !entities.has(value.subject) ||
    !nullableString(value.object) ||
    !nullableString(value.literal) ||
    typeof value.summary !== 'string' ||
    !value.summary.trim() ||
    typeof value.branch !== 'boolean' ||
    !nullableString(value.validFrom) ||
    !strings(value.quotes) ||
    !nullableString(value.supersedes)
  )
    return
  let predicate = vocabulary<BrainPredicate>(value.predicate, BRAIN_PREDICATES)
  const kind = vocabulary<BrainEpistemicKind>(value.kind, ['observed', 'reported', 'inferred'])
  const type = vocabulary<BrainMemoryType>(value.type, BRAIN_MEMORY_TYPES)
  if (!predicate || !kind || !type) return
  let object = value.object
  let literal = value.literal
  if (object !== null) {
    const bothNamed = [entities.get(value.subject), entities.get(object)].every(
      (e) => e && [e.label, ...e.aliases].some((name) => mentions(value.summary as string, name)),
    )
    if (!bothNamed) {
      predicate = 'about'
      object = null
      literal = null
    } else literal = null
  }
  const date =
    value.validFrom && /^\d{4}-\d{2}-\d{2}$/.test(value.validFrom)
      ? Date.parse(value.validFrom)
      : NaN
  const validFrom =
    Number.isFinite(date) && new Date(date).toISOString().slice(0, 10) === value.validFrom
      ? date
      : null
  return {
    subject: value.subject,
    predicate,
    object,
    literal,
    summary: value.summary.trim(),
    kind,
    type,
    branch: value.branch,
    validFrom,
    quotes: value.quotes.filter((q) => q.length > 0 && q.length <= 160).slice(0, 2),
    supersedes: value.supersedes,
  }
}

function candidateSummary(value: unknown): string {
  return record(value) && typeof value.summary === 'string' ? value.summary : '(invalid candidate)'
}

/** Invalid individual items are discarded; a model's malformed JSON yields an empty proposal. */
export function parseExtraction(text: string, limits: ExtractionLimits = {}): RawExtraction {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('The extraction returned no JSON.')
  const empty: RawExtraction = { summary: '', entities: [], memories: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return empty
  }
  if (!record(parsed) || !Array.isArray(parsed.memories)) return empty
  if (typeof parsed.summary !== 'string' || !Array.isArray(parsed.entities)) {
    parsed.memories.forEach((value, candidate) =>
      limits.onCandidate?.(candidate, undefined, candidateSummary(value), 'invalid shape'),
    )
    return empty
  }
  const keys = new Set<string>()
  const entities = parsed.entities
    .flatMap((value) => {
      const e = entity(value)
      if (!e || keys.has(e.key)) return []
      keys.add(e.key)
      return [e]
    })
    .slice(0, limits.maxEntities ?? 15)
  const known = new Map((limits.existingEntities ?? []).map((e) => [e.id, e]))
  for (const e of entities) if (!known.has(e.key)) known.set(e.key, { ...e, id: e.key })
  const memories: RawMemory[] = []
  parsed.memories.forEach((value, candidate) => {
    const m = memory(value, known)
    const summary = candidateSummary(value)
    const capped = memories.length >= (limits.maxMemories ?? 20)
    const rewritten = m && record(value) && value.object !== null && m.object === null
    limits.onCandidate?.(
      candidate,
      capped ? undefined : m,
      summary,
      capped ? 'candidate limit' : rewritten ? 'link check rewritten' : undefined,
    )
    if (m && !capped) memories.push(m)
  })
  return { summary: parsed.summary, entities, memories }
}
