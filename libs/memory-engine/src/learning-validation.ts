import type { BrainLearningStart } from '@phosphor/shared/brain-learning-jobs'
import type { BrainLearningUsage } from '@phosphor/shared/brain-learning'
import * as validate from './validation'

export const LEARNING_BYTES = 4_000_000
function fields(value: object, keys: string[]): void {
  validate.check(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).every((key) => keys.includes(key)),
    'Unknown learning metadata field',
  )
}
export function usage(value: BrainLearningUsage): void {
  validate.check(value && typeof value === 'object', 'Invalid learning usage')
  validate.check(
    Object.keys(value).sort().join(',') === 'cacheRead,cacheWrite,input,output,reasoning',
    'Invalid learning usage fields',
  )
  for (const count of Object.values(value))
    validate.check(
      count === null || (typeof count === 'number' && Number.isFinite(count) && count >= 0),
      'Invalid learning usage count',
    )
  validate.check(
    value.reasoning === null || (value.output !== null && value.reasoning <= value.output),
    'Reasoning is included in output',
  )
}
export function contributions(items: BrainLearningStart['covered']): void {
  validate.list(items, 1000)
  validate.check(items.length > 0, 'Learning needs projected contributions')
  const ids = new Set<string>()
  for (const item of items) {
    for (const value of [item.entryId, item.entryHash, item.rootId, item.projectedHash])
      validate.text(value, 200)
    fields(item, ['entryId', 'parentId', 'entryHash', 'rootId', 'projectedHash'])
    if (item.parentId !== null) validate.text(item.parentId, 200)
    validate.check(!ids.has(item.entryId), 'Duplicate learning contribution')
    ids.add(item.entryId)
  }
}
function metadata(input: BrainLearningStart): void {
  validate.bounded(input, LEARNING_BYTES)
  fields(input, [
    'jobId',
    'scope',
    'branch',
    'target',
    'binding',
    'checkpoint',
    'covered',
    'dependencyRootIds',
    'evidence',
    'expectedPolicyEpoch',
    'retryJobId',
  ])
  fields(input.target, ['workspacePath', 'sessionPath'])
  fields(input.binding, [
    'provider',
    'modelId',
    'api',
    'accountId',
    'authMode',
    'thinkingLevel',
    'endpoint',
  ])
  fields(input.checkpoint, ['source', 'sourceEntryCount', 'projectionDigest'])
  fields(input.checkpoint.source, ['sessionId', 'selectedLeafId', 'sourceDigest', 'contentDigest'])
}
export function start(input: BrainLearningStart): void {
  metadata(input)
  for (const value of [
    input.jobId,
    input.scope,
    input.target.workspacePath,
    input.target.sessionPath,
  ])
    validate.text(value)
  validate.check(input.jobId.length <= 200, 'Learning owner ID exceeds bounds')
  if (input.branch !== null) validate.text(input.branch, 1000)
  if (input.retryJobId !== undefined) validate.text(input.retryJobId, 200)
  const { source, projectionDigest, sourceEntryCount } = input.checkpoint
  for (const value of [
    source.sessionId,
    source.selectedLeafId,
    source.sourceDigest,
    source.contentDigest,
    projectionDigest,
  ])
    validate.text(value, 200)
  validate.check(
    !Object.hasOwn(source, 'entries'),
    'Learning metadata cannot contain source entries',
  )
  validate.check(
    Number.isSafeInteger(sourceEntryCount) && sourceEntryCount > 0 && sourceEntryCount <= 10000,
    'Invalid learning source count',
  )
  validate.check(
    Number.isSafeInteger(input.expectedPolicyEpoch) && input.expectedPolicyEpoch >= 0,
    'Invalid learning policy',
  )
  binding(input.binding)
  contributions(input.covered)
  validate.strings(input.dependencyRootIds, 1000)
  validate.check(
    input.dependencyRootIds.length > 0 &&
      new Set(input.dependencyRootIds).size === input.dependencyRootIds.length,
    'Invalid learning dependencies',
  )
  evidence(input)
}
function evidence(input: BrainLearningStart): void {
  validate.list(input.evidence, 1000)
  validate.check(input.evidence.length > 0, 'Learning needs evidence')
  validate.check(
    input.evidence.filter((item) => item.eligible).length <= 200,
    'Learning eligible context exceeds limit',
  )
  const ids = new Set<string>(),
    roots = new Set<string>()
  for (const item of input.evidence) {
    validate.text(item.evidenceId, 500)
    validate.text(item.text, LEARNING_BYTES)
    validate.strings(item.rootIds, 1000)
    validate.check(
      item.rootIds.length > 0 &&
        item.rootIds.every((root) => input.dependencyRootIds.includes(root)),
      'Unbound learning provenance',
    )
    item.rootIds.forEach((root) => roots.add(root))
    validate.check(!ids.has(item.evidenceId), 'Duplicate learning evidence identity')
    ids.add(item.evidenceId)
    const contribution = input.covered.find((value) => value.entryId === item.entryId)
    validate.check(
      contribution &&
        ['parentId', 'entryHash', 'rootId', 'projectedHash'].every(
          (key) =>
            contribution[key as keyof typeof contribution] === item[key as keyof typeof item],
        ),
      'Learning evidence contribution mismatch',
    )
    validate.check(typeof item.eligible === 'boolean', 'Invalid learning eligibility')
    validate.check(
      ['user', 'assistant', 'toolResult'].includes(item.role),
      'Unsupported learning role',
    )
    validate.check(
      item.sourceType === 'message' || (item.sourceType === 'compaction' && item.role === 'user'),
      'Unsupported learning provenance',
    )
    if (item.sourceType === 'message' && item.role !== 'assistant')
      validate.check(
        item.rootIds.length === 1 && item.rootIds[0] === item.entryId,
        'Original learning evidence needs original input ID',
      )
  }
  validate.check(
    roots.size === input.dependencyRootIds.length,
    'Learning dependencies differ from projected context',
  )
}

function binding(binding: BrainLearningStart['binding']): void {
  for (const value of [
    binding.provider,
    binding.modelId,
    binding.api,
    binding.accountId,
    binding.endpoint,
  ])
    validate.text(value, 500)
  validate.check(
    ['oauth', 'api-key', 'cli'].includes(binding.authMode),
    'Invalid learning account mode',
  )
  validate.check(
    ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(binding.thinkingLevel),
    'Invalid learning thinking level',
  )
}
