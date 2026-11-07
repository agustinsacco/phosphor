import { BRAIN_ENTITY_KINDS, BRAIN_PREDICATES } from '@phosphor/shared/brain'
import type {
  BrainLearningEntity,
  BrainLearningFinding,
  BrainLearningEvidence,
  BrainLearningResult,
  BrainLearningUsage,
} from '@phosphor/shared/brain-learning'

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error('Invalid learning JSON shape')
  return value as Record<string, unknown>
}
function boundedText(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error('Invalid learning text')
  return value
}
function entity(value: unknown): BrainLearningEntity {
  const raw = object(value, ['label', 'kind'])
  if (!BRAIN_ENTITY_KINDS.includes(raw.kind as BrainLearningEntity['kind']))
    throw new Error('Invalid learning entity kind')
  return { label: boundedText(raw.label, 500), kind: raw.kind as BrainLearningEntity['kind'] }
}
function semantics(
  raw: Record<string, unknown>,
): Pick<
  BrainLearningFinding,
  'subject' | 'predicate' | 'object' | 'literal' | 'validFrom' | 'validTo'
> {
  if (!BRAIN_PREDICATES.includes(raw.predicate as BrainLearningFinding['predicate']))
    throw new Error('Invalid learning predicate')
  if (Object.hasOwn(raw, 'object') === Object.hasOwn(raw, 'literal'))
    throw new Error('Learning requires exactly one object or literal')
  for (const key of ['validFrom', 'validTo'])
    if (raw[key] !== null && (!Number.isSafeInteger(raw[key]) || Number(raw[key]) < 0))
      throw new Error('Invalid learning time')
  const validFrom = raw.validFrom as number | null
  const validTo = raw.validTo as number | null
  if (validFrom !== null && validTo !== null && validFrom >= validTo)
    throw new Error('Invalid learning time range')
  return {
    subject: entity(raw.subject),
    predicate: raw.predicate as BrainLearningFinding['predicate'],
    ...(Object.hasOwn(raw, 'object')
      ? { object: entity(raw.object) }
      : { literal: boundedText(raw.literal, 2000) }),
    validFrom,
    validTo,
  }
}
export function resolveLearningOutcome(
  text: string,
  evidence: BrainLearningEvidence[],
): BrainLearningResult['outcome'] {
  if (Buffer.byteLength(text) > 262_144) throw new Error('Learning output exceeds limit')
  const raw = object(JSON.parse(text), ['type', 'findings'])
  if (raw.type === 'no_findings' && Object.keys(raw).length === 1) return { type: 'no_findings' }
  if (
    raw.type !== 'findings' ||
    !Array.isArray(raw.findings) ||
    !raw.findings.length ||
    raw.findings.length > 32
  )
    throw new Error('Invalid learning findings')
  const findings = raw.findings.map((value: unknown) => {
    const finding = object(value, [
      'summary',
      'kind',
      'citations',
      'subject',
      'predicate',
      'object',
      'literal',
      'validFrom',
      'validTo',
    ])
    const semantic = semantics(finding)
    const summary = boundedText(finding.summary, 2000)
    if (finding.kind !== 'observed' && finding.kind !== 'reported' && finding.kind !== 'inferred')
      throw new Error('Invalid learning epistemic kind')
    if (
      !Array.isArray(finding.citations) ||
      !finding.citations.length ||
      finding.citations.length > 8
    )
      throw new Error('Invalid learning citations')
    const citations = finding.citations.map((value: unknown) => {
      const citation = object(value, ['role', 'quote'])
      const quote = boundedText(citation.quote, 2000)
      const matches = evidence.filter(
        (item) => item.role === citation.role && item.text.includes(quote),
      )
      if (matches.length !== 1 || !matches[0]!.eligible)
        throw new Error('Missing, ambiguous or already-covered learning citation')
      return { evidenceId: matches[0]!.evidenceId, quote }
    })
    const kind: 'observed' | 'reported' | 'inferred' = finding.kind
    return { ...semantic, summary, kind, citations }
  })
  return { type: 'findings', findings }
}
/** Read only this response's usage; unavailable never means zero. Reasoning is not added. */
export function learningUsage(value: unknown): BrainLearningUsage {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const count = (key: string): number | null =>
    typeof raw[key] === 'number' && Number.isFinite(raw[key]) && raw[key] >= 0 ? raw[key] : null
  const output = count('output'),
    reasoning = count('reasoning')
  return {
    input: count('input'),
    output,
    cacheRead: count('cacheRead'),
    cacheWrite: count('cacheWrite'),
    reasoning: output !== null && reasoning !== null && reasoning <= output ? reasoning : null,
  }
}
export function learningResponse(value: unknown): { text: string; usage: BrainLearningUsage } {
  if (!value || typeof value !== 'object') throw new Error('Missing learning response')
  const response = value as Record<string, unknown>
  if (
    response.role !== 'assistant' ||
    response.stopReason !== 'stop' ||
    !Array.isArray(response.content)
  )
    throw new Error('Learning response stopped without a complete answer')
  let text = ''
  for (const raw of response.content) {
    const block = object(raw, [
      'type',
      'text',
      'textSignature',
      'thinking',
      'thinkingSignature',
      'redacted',
    ])
    if (block.type === 'thinking') continue
    if (block.type !== 'text' || typeof block.text !== 'string')
      throw new Error('Learning emitted a tool or unsupported block')
    text += block.text
  }
  return { text, usage: learningUsage(response.usage) }
}
