import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { BrainSnapshot } from '@phosphor/shared/brain'
import type { BrainLearningCoverage } from '@phosphor/shared/brain-learning'
import { learningCheckpointSummary } from '@phosphor/shared/brain-learning-jobs'
import type {
  BrainLearningPreview,
  BrainLearningStoreOperations,
  BrainLearningTarget,
} from '@phosphor/shared/brain-learning-jobs'
import { bounded, fields, laneAuthority } from './authority'
import type { BrainLearningHost, PreparedBrainLearning } from './learning-port'

export type LearningStore = {
  [K in keyof BrainLearningStoreOperations]: (
    ...args: Parameters<BrainLearningStoreOperations[K]>
  ) => Promise<ReturnType<BrainLearningStoreOperations[K]>>
} & { snapshot(): Promise<BrainSnapshot> }
export interface LearningPreflightOptions {
  store: LearningStore
  host: BrainLearningHost
  authority?: typeof laneAuthority
  canonicalTarget?(target: BrainLearningTarget): Promise<BrainLearningTarget>
}
export interface LearningPreflight {
  prepared: PreparedBrainLearning
  preview: BrainLearningPreview
  covered: Array<Pick<BrainLearningCoverage, 'rootId' | 'projectedHash'>>
}
export const learningDigest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function learningTarget(value: BrainLearningTarget): BrainLearningTarget {
  fields(value, ['workspacePath', 'sessionPath'])
  for (const path of [value.workspacePath, value.sessionPath])
    if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096)
      throw new Error('Invalid learning source path')
  return { workspacePath: value.workspacePath, sessionPath: value.sessionPath }
}
export async function canonicalLearningTarget(
  value: BrainLearningTarget,
): Promise<BrainLearningTarget> {
  return {
    workspacePath: await realpath(value.workspacePath),
    sessionPath: await realpath(value.sessionPath),
  }
}
export async function learningPreflight(
  options: LearningPreflightOptions,
  input: BrainLearningTarget,
  jobId: string,
  signal: AbortSignal,
): Promise<LearningPreflight> {
  const target = await (options.canonicalTarget ?? canonicalLearningTarget)(learningTarget(input))
  const authority = await (options.authority ?? laneAuthority)(target.workspacePath)
  const snapshot = await options.store.snapshot()
  if (!snapshot.prefs.enabled || !snapshot.prefs.workspaces.includes(authority.scope))
    throw new Error('Learning requires an enabled, enrolled workspace')
  signal.throwIfAborted()
  const prepared = await options.host.prepare(target, jobId, signal)
  try {
    signal.throwIfAborted()
    if (prepared.scope !== authority.scope || prepared.branch !== authority.branch)
      throw new Error('Learning workspace authority changed')
    if (
      !Number.isSafeInteger(prepared.maxOutputTokens) ||
      prepared.maxOutputTokens < 1 ||
      prepared.maxOutputTokens > 32768
    )
      throw new Error('Learning selected model output limit unavailable')
    const { source, covered, projectionDigest, rootIds } = prepared.checkpoint
    bounded({ covered, evidence: prepared.evidence, rootIds }, 4_000_000)
    const prior = await options.store.learningCoverage(
      authority.scope,
      source.sessionId,
      projectionDigest,
      covered,
      rootIds,
    )
    const current = await options.store.snapshot()
    if (
      current.policyEpoch !== snapshot.policyEpoch ||
      !current.prefs.enabled ||
      !current.prefs.workspaces.includes(authority.scope)
    )
      throw new Error('Learning consent changed during preparation')
    const known = new Set(prior.covered.map(learningDigest))
    const checkpoint = learningCheckpointSummary(prepared.checkpoint)
    const newCount = covered.filter(
      ({ rootId, projectedHash }) => !known.has(learningDigest({ rootId, projectedHash })),
    ).length
    const identity = {
      target,
      ...authority,
      checkpoint,
      binding: prepared.binding,
      maxOutputTokens: prepared.maxOutputTokens,
      policyEpoch: current.policyEpoch,
      graphRevision: current.graphRevision,
    }
    return {
      prepared,
      covered: prior.covered,
      preview: {
        ...identity,
        fingerprint: learningDigest(identity),
        coveredCount: covered.length - newCount,
        newCount,
        previousJobId: prior.previousJobId,
        limitations: [
          'One logical response; provider-internal network attempts are not observable.',
          'The binding identifies the selected current credential slot, not proof of historical billing identity.',
          'Only pi-projected context is seen. Existing compaction and context edits remain in effect.',
          'Copied history does not guarantee an identical serialized prefix, a warm process or cache hits.',
          'Findings require manual review. Failed or cancelled calls may already have incurred usage.',
        ],
      },
    }
  } catch (error) {
    await prepared.dispose()
    throw error
  }
}
