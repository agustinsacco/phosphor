import type {
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
    const finding = object(value, ['summary', 'kind', 'citations'])
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
    return { summary, kind, citations }
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
