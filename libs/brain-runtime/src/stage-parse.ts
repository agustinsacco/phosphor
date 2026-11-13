import {
  BRAIN_ENTITY_KINDS,
  BRAIN_MEMORY_TYPES,
  BRAIN_PREDICATES,
  BRAIN_STRUCTURAL_PREDICATES,
} from '@phosphor/shared/brain'
import type {
  StageClaim,
  StageEntity,
  StageExtraction,
  StageLink,
  StageParent,
  StageQuote,
  Registry,
} from './stage-types'
import type { TranscriptWindow } from './windows'
import { ELISION } from './constants'
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

/** Verify within a single unelided span; a mistaken handle may be corrected, not invented. */
export function verifiedQuote(value: unknown, window: TranscriptWindow): StageQuote {
  const q = object(value),
    quote = text(q.quote),
    segment = ref(q.segment, 's')
  if (ELISION.test(quote)) throw new Error('A quote cannot contain an elision marker')
  const supports = (index: number): boolean =>
    window.segments[index]?.text.split(ELISION).some((span) => span.includes(quote)) ?? false
  let index = Number(segment.slice(1)) - 1
  if (!supports(index)) index = window.segments.findIndex((_s, i) => supports(i))
  if (index < 0) throw new Error(`Quote not found in ${segment}: ${quote.slice(0, 100)}`)
  return { segment: `s${index + 1}`, quote }
}
function claim(value: unknown, refs: Set<string>, window: TranscriptWindow): StageClaim {
  const c = object(value)
  const known = (v: unknown): string => {
    const id = text(v)
    if (!refs.has(id)) throw new Error(`Unknown entity ref: ${id}`)
    return id
  }
  const quotes = array(c.quotes).map((q) => verifiedQuote(q, window))
  if (!quotes.length) throw new Error(`Claim ${String(c.ref)} has no quotes`)
  const errors: string[] = []
  const links: StageLink[] = validated(
    array(c.links),
    (v) => {
      const l = object(v)
      const subject = known(l.subject),
        target = known(l.object)
      if (subject === target) throw new Error('A relationship cannot link an entity to itself')
      return {
        subject,
        object: target,
        predicate: vocabulary(l.predicate, BRAIN_PREDICATES),
        ...verifiedQuote(l, window),
      }
    },
    `Claim ${String(c.ref)} link`,
    errors,
  )
  if (errors.length) throw new Error(errors.join('\n'))
  if (typeof c.branch !== 'boolean') throw new Error('branch must be boolean')
  return {
    ref: ref(c.ref, 'c'),
    text: scrubExcerpt(text(c.text)),
    type: vocabulary(c.type, BRAIN_MEMORY_TYPES),
    epistemic: vocabulary(c.epistemic, ['observed', 'reported', 'inferred']),
    mentions: [
      ...new Set([...array(c.mentions).map(known), ...links.flatMap((l) => [l.subject, l.object])]),
    ],
    links,
    quotes,
    validFrom: date(c.validFrom),
    validTo: date(c.validTo),
    branch: c.branch,
  }
}
function unique(values: string[]): void {
  if (new Set(values).size !== values.length) throw new Error('Duplicate ref')
}
function parent(value: unknown, refs: Set<string>, claims: StageClaim[]): StageParent {
  const p = object(value),
    id = text(p.entity)
  if (!refs.has(id)) throw new Error(`Unknown parent entity ref: ${id}`)
  const status = vocabulary(p.status, ['stated', 'not_stated', 'unclear'])
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
  const errors: string[] = []
  const entities = validated(array(data.entities), entity, 'entity', errors)
  unique(entities.map((e) => e.ref))
  const refs = new Set([...registry.map((e) => ref(e.ref, 'r')), ...entities.map((e) => e.ref)])
  const claims = validated(array(data.claims), (c) => claim(c, refs, window), 'claim', errors)
  unique(claims.map((c) => c.ref))
  const parents = validated(array(data.parents), (p) => parent(p, refs, claims), 'parent', errors)
  unique(parents.map((p) => p.entity))
  for (const e of entities.filter((e) =>
    ['project', 'component', 'document', 'team'].includes(e.kind),
  ))
    if (!parents.some((p) => p.entity === e.ref))
      errors.push(`Missing parent assessment for ${e.ref}`)
  if (errors.length) throw new Error(errors.join('\n'))
  return { entities, claims, parents }
}

function validated<T>(
  values: unknown[],
  parse: (value: unknown) => T,
  label: string,
  errors: string[],
): T[] {
  return values.flatMap((value, index) => {
    try {
      return [parse(value)]
    } catch (error) {
      errors.push(
        `${label}[${index + 1}]: ${error instanceof Error ? error.message : String(error)}`,
      )
      return []
    }
  })
}
