import {
  BRAIN_ENTITY_KINDS,
  BRAIN_MEMORY_TYPES,
  BRAIN_PREDICATES,
  BRAIN_LINK_RULES,
  type BrainEntityKind,
  type BrainExtractionOutcome,
  BRAIN_STRUCTURAL_PREDICATES,
} from '@phosphor/shared/brain'
import type {
  StageClaim,
  StageEntity,
  StageExtraction,
  StageLink,
  StageParent,
  Registry,
} from './stage-types'
import type { TranscriptWindow } from './windows'
import { MAX_PART_CLAIMS } from './constants'
import { verifiedQuote } from './stage-quote'
export { verifiedQuote } from './stage-quote'
import { fold } from '@phosphor/memory-engine/text'
import { scrubExcerpt } from '@phosphor/memory-engine/secrets'

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object')
  return value as Record<string, unknown>
}
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected an array')
  return value
}
export function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Expected nonempty text')
  return value
}
export function jsonAnswer(answer: string): Record<string, unknown> {
  const start = answer.indexOf('{'),
    end = answer.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('The stage returned no JSON object')
  return object(JSON.parse(answer.slice(start, end + 1)))
}
function vocabulary<T extends string>(value: unknown, values: readonly T[]): T {
  if (!values.includes(value as T)) throw new Error(`Unknown vocabulary: ${String(value)}`)
  return value as T
}
function ref(value: unknown, namespace: string): string {
  const result = text(value)
  if (!new RegExp(`^${namespace}[1-9]\\d*$`).test(result))
    throw new Error(`Invalid ${namespace} ref: ${result}`)
  return result
}
function date(value: unknown): number | null {
  if (value === null) return null
  const raw = text(value)
  const parsed = Date.parse(raw)
  if (
    !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(raw) ||
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString().slice(0, 10) !== raw.slice(0, 10)
  )
    throw new Error(`Invalid date: ${raw}`)
  return parsed
}
function entity(value: unknown): StageEntity {
  const e = object(value)
  const label = text(e.label)
  if (scrubExcerpt(label) !== label) throw new Error('Sensitive entity label')
  const description = typeof e.description === 'string' ? e.description : ''
  if (description.length > 160) throw new Error('Entity description exceeds 160 characters')
  return {
    ref: ref(e.ref, 'n'),
    label,
    kind: vocabulary(e.kind, BRAIN_ENTITY_KINDS),
    aliases: array(e.aliases)
      .map(text)
      .filter((alias) => scrubExcerpt(alias) === alias),
    description: scrubExcerpt(description),
    keys: array(e.keys).map((value) => {
      const key = object(value)
      const namespace = text(key.namespace),
        v = text(key.value)
      if (scrubExcerpt(v) !== v || scrubExcerpt(namespace) !== namespace)
        throw new Error('Sensitive entity key')
      return { namespace, value: v }
    }),
  }
}

function claim(
  value: unknown,
  kinds: Map<string, BrainEntityKind>,
  window: TranscriptWindow,
  outcomes: BrainExtractionOutcome[],
): StageClaim {
  const c = object(value),
    id = ref(c.ref, 'c')
  const known = (v: unknown): string => {
    const id = text(v)
    if (!kinds.has(id)) throw new Error(`Unknown entity ref: ${id}`)
    return id
  }
  const quotes = tolerant(
    array(c.quotes),
    (q) => verifiedQuote(q, window),
    () => id,
    outcomes,
  )
  if (!quotes.length) throw new Error(`Claim ${id} has no valid quotes`)
  const mentions = new Set(array(c.mentions).map(known))
  const links: StageLink[] = tolerant(
    Array.isArray(c.links) ? c.links : [c.links],
    (v) => {
      const l = object(v)
      for (const endpoint of [l.subject, l.object])
        if (typeof endpoint === 'string' && kinds.has(endpoint)) mentions.add(endpoint)
      const subject = known(l.subject),
        target = known(l.object)
      if (subject === target) throw new Error('A relationship cannot link an entity to itself')
      const predicate = vocabulary(l.predicate, BRAIN_PREDICATES)
      const rule = BRAIN_LINK_RULES[predicate]
      if (!rule.subject.includes(kinds.get(subject)!) || !rule.object.includes(kinds.get(target)!))
        throw new Error(`Invalid endpoint kinds for ${predicate}`)
      return { subject, object: target, predicate, ...verifiedQuote(l, window) }
    },
    () => id,
    outcomes,
  )
  if (typeof c.branch !== 'boolean') throw new Error('branch must be boolean')
  return {
    ref: id,
    text: scrubExcerpt(text(c.text)),
    type: vocabulary(c.type, BRAIN_MEMORY_TYPES),
    epistemic: vocabulary(c.epistemic, ['observed', 'reported', 'inferred']),
    mentions: [...mentions],
    links,
    quotes,
    validFrom: date(c.validFrom),
    validTo: date(c.validTo),
    branch: c.branch,
  }
}
function parent(
  value: unknown,
  refs: Map<string, BrainEntityKind>,
  claims: StageClaim[],
): StageParent {
  const p = object(value),
    id = text(p.entity)
  if (!refs.has(id)) throw new Error(`Unknown parent entity ref: ${id}`)
  const status = vocabulary(p.status, ['stated', 'not_stated'])
  const claimRef = p.claim === null ? null : text(p.claim)
  if (status === 'stated') {
    const supported = claims
      .find((c) => c.ref === claimRef)
      ?.links.some(
        (l) => l.subject === id && BRAIN_STRUCTURAL_PREDICATES.some((v) => v === l.predicate),
      )
    if (!supported) throw new Error(`Parent for ${id} lacks a structural supporting claim`)
  } else if (claimRef !== null) throw new Error('Unstated parent cannot cite a claim')
  return { entity: id, status, claim: claimRef }
}
export function parseStageExtraction(
  answer: string,
  window: TranscriptWindow,
  registry: Registry = [],
): StageExtraction {
  const data = jsonAnswer(answer)
  const rawEntities = array(data.entities),
    rawClaims = array(data.claims)
  const outcomes: BrainExtractionOutcome[] = []
  const entityRefs = new Set<string>(),
    claimRefs = new Set<string>()
  const entities = tolerant(
    rawEntities,
    (v) => {
      const e = entity(v)
      uniqueRef(e.ref, entityRefs)
      return e
    },
    candidate('entity', 'n'),
    outcomes,
  )
  const kinds = new Map([...registry, ...entities].map((e) => [e.ref, e.kind]))
  const claims = tolerant(
    rawClaims,
    (v, index) => {
      if (index >= MAX_PART_CLAIMS) throw new Error('Over the 25-claim limit for one part')
      const c = claim(v, kinds, window, outcomes)
      uniqueRef(c.ref, claimRefs)
      return c
    },
    candidate('claim', 'c'),
    outcomes,
  )
  const parents: StageParent[] = []
  for (const value of Array.isArray(data.parents) ? data.parents : []) {
    try {
      const p = parent(value, kinds, claims)
      if (!parents.some((other) => other.entity === p.entity)) parents.push(p)
    } catch {
      /* Invalid parent assessments are equivalent to not stated. */
    }
  }
  for (const e of entities)
    if (
      ['project', 'component', 'document', 'team'].includes(e.kind) &&
      !parents.some((p) => p.entity === e.ref)
    )
      parents.push({ entity: e.ref, status: 'not_stated', claim: null })
  for (const entity of entities) {
    entity.keys = entity.keys.filter((key) => {
      if (window.segments.some((segment) => fold(segment.text).includes(fold(key.value))))
        return true
      outcomes.push({
        candidate: entity.ref,
        summary: `Unsupported entity key ${key.namespace}: ${key.value}`,
        status: 'dropped',
        reason: 'Entity key value not found in the window source',
      })
      return false
    })
  }
  return { entities, claims, parents, ...(outcomes.length ? { outcomes } : {}) }
}

function uniqueRef(ref: string, seen: Set<string>): void {
  if (seen.has(ref)) throw new Error('Duplicate ref')
  seen.add(ref)
}
function candidate(label: string, namespace: string) {
  return (value: unknown, index: number): string => {
    try {
      return ref(object(value).ref, namespace)
    } catch {
      return `${label}[${index + 1}]`
    }
  }
}
function tolerant<T>(
  values: unknown[],
  parse: (value: unknown, index: number) => T,
  candidate: (value: unknown, index: number) => string,
  outcomes: BrainExtractionOutcome[],
): T[] {
  return values.flatMap((value, index) => {
    try {
      return [parse(value, index)]
    } catch (error) {
      const reason = scrubExcerpt(error instanceof Error ? error.message : String(error))
      outcomes.push({
        candidate: candidate(value, index),
        summary: reason,
        status: 'dropped',
        reason,
      })
      return []
    }
  })
}

/** Invalid rows do not discard valid decisions; only an unusable envelope needs repair. */
export function validDecisions<T extends { ref: string }>(
  answer: string,
  parse: (value: unknown) => T,
): T[] {
  const decisions = new Map<string, T>()
  for (const value of array(jsonAnswer(answer).decisions)) {
    try {
      const d = parse(value)
      if (!decisions.has(d.ref)) decisions.set(d.ref, d)
    } catch {
      /* Missing valid decisions are requested once more by the stage. */
    }
  }
  return [...decisions.values()]
}
