import { BRAIN_ENTITY_KINDS } from '@phosphor/shared/brain'
import type { BrainEntityProposal, BrainProposalInput } from '@phosphor/shared/brain'
import type { BrainLearningEntity, BrainLearningResult } from '@phosphor/shared/brain-learning'
import { identifier } from './data'
import type { Evidence } from './evidence'
import type { LearningReceipt } from './learning-receipts'
import * as validate from './validation'

type Finding = Extract<BrainLearningResult['outcome'], { type: 'findings' }>['findings'][number]
function shape(value: object, keys: string[]): void {
  validate.check(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).every((key) => keys.includes(key)),
    'Invalid learning result fields',
  )
}
function citations(finding: Finding, input: LearningReceipt, evidence: Evidence) {
  validate.list(finding.citations, 8)
  return finding.citations.map((citation) => {
    shape(citation, ['evidenceId', 'quote'])
    validate.text(citation.evidenceId, 500)
    validate.text(citation.quote, 2000)
    const source = input.evidence.find((item) => item.evidenceId === citation.evidenceId)
    validate.check(source?.eligible, 'Missing or already-covered learning citation')
    validate.check(
      finding.kind !== 'observed' ||
        (source.sourceType === 'message' && source.role !== 'assistant'),
      'Generated learning evidence is not an independent observation',
    )
    const chunk = source.chunks.find(({ id }) =>
      evidence.read(id, [input.scope]).text.includes(citation.quote),
    )
    validate.check(chunk, 'Quote absent from immutable learning evidence')
    return { evidenceId: chunk.id, quote: citation.quote }
  })
}
function entityKey(
  entities: Map<string, BrainEntityProposal>,
  value: BrainLearningEntity,
  ids: string[],
): string {
  shape(value, ['label', 'kind'])
  validate.text(value.label, 500)
  validate.check(BRAIN_ENTITY_KINDS.includes(value.kind), 'Invalid learning entity kind')
  const label = value.label.normalize('NFKC').trim().replace(/\s+/g, ' ')
  const key = identifier('learning-entity', value.kind, label.toLowerCase())
  const old = entities.get(key)
  entities.set(key, {
    key,
    label: old?.label ?? label,
    kind: value.kind,
    aliases: [],
    evidenceIds: [...new Set([...(old?.evidenceIds ?? []), ...ids])].sort(),
  })
  return key
}
export function learningProposal(
  outcome: BrainLearningResult['outcome'],
  input: LearningReceipt,
  evidence: Evidence,
): BrainProposalInput | null {
  validate.bounded(outcome, 262144)
  shape(outcome, ['type', 'findings'])
  if (outcome.type === 'no_findings') {
    validate.check(Object.keys(outcome).length === 1, 'Invalid no_findings result')
    return null
  }
  validate.check(outcome.type === 'findings', 'Invalid learning outcome')
  validate.list(outcome.findings, 32)
  validate.check(outcome.findings.length > 0, 'Empty learning findings')
  const entities = new Map<string, BrainEntityProposal>()
  const claims = outcome.findings.map((finding) => {
    shape(finding, [
      'subject',
      'predicate',
      'object',
      'literal',
      'validFrom',
      'validTo',
      'summary',
      'kind',
      'citations',
    ])
    validate.text(finding.summary, 2000)
    if (finding.literal !== undefined) validate.text(finding.literal, 2000)
    for (const value of [finding.validFrom, finding.validTo])
      validate.check(
        value === null || (Number.isSafeInteger(value) && value >= 0),
        'Invalid learning time',
      )
    const mapped = citations(finding, input, evidence)
    const ids = mapped.map((citation) => citation.evidenceId)
    validate.check(
      (finding.object !== undefined) !== (finding.literal !== undefined),
      'Learning finding needs one object or literal',
    )
    return {
      subject: entityKey(entities, finding.subject, ids),
      predicate: finding.predicate,
      ...(finding.object !== undefined
        ? { object: entityKey(entities, finding.object, ids) }
        : { literal: finding.literal }),
      summary: finding.summary,
      kind: finding.kind,
      citations: mapped,
      validFrom: finding.validFrom,
      validTo: finding.validTo,
    }
  })
  const proposal = {
    entities: [...entities.values()],
    claims,
    rationale:
      'Selective learning from immutable projected source evidence; exact citations require human review.',
  }
  validate.proposal(proposal)
  return proposal
}
