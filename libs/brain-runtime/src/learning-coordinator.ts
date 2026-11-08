import { randomUUID } from 'node:crypto'
import type { BrainJob } from '@phosphor/shared/brain'
import type {
  BrainLearningRequest,
  BrainLearningResult,
  BrainLearningUsage,
} from '@phosphor/shared/brain-learning'
import type {
  BrainLearningConsent,
  BrainLearningPreview,
  BrainLearningTarget,
} from '@phosphor/shared/brain-learning-jobs'
import { bounded, fields, identifier, laneAuthority } from './authority'
import { abortable } from './processor-wait'
import {
  learningDigest,
  learningPreflight,
  type LearningPreflight,
  type LearningPreflightOptions,
} from './learning-preflight'

interface LearningOptions extends LearningPreflightOptions {
  store: LearningPreflightOptions['store'] & { claimJob(id: string): Promise<BrainJob> }
  jobId?(): string
  now?(): number
  report?(error: unknown): void
}
interface Active {
  id: string
  abort: AbortController
  admission: Promise<void>
  admitted(): void
  timer: ReturnType<typeof setTimeout>
  done?: Promise<void>
  preflight?: LearningPreflight
  job?: BrainJob
}
function consentInput(consent: BrainLearningConsent): void {
  fields(consent, ['policyEpoch', 'fingerprint', 'retryJobId'])
  if (!Number.isSafeInteger(consent.policyEpoch) || !/^[a-f0-9]{64}$/.test(consent.fingerprint))
    throw new Error('Invalid learning consent')
  if (consent.retryJobId !== undefined) identifier(consent.retryJobId)
}
function failureUsage(error: unknown): BrainLearningUsage | null {
  if (!error || typeof error !== 'object' || !('learningUsage' in error)) return null
  const raw = error.learningUsage
  if (!raw || typeof raw !== 'object') return null
  const count = (key: keyof BrainLearningUsage) => {
    const value = (raw as Record<string, unknown>)[key]
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
  }
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
export function createBrainLearning(options: LearningOptions) {
  return new BrainLearning(options)
}
class BrainLearning {
  private active?: Active
  private closed = false
  constructor(private readonly options: LearningOptions) {}
  preview = async (target: BrainLearningTarget): Promise<BrainLearningPreview> => {
    const active = this.reserve()
    try {
      active.preflight = await learningPreflight(
        this.options,
        target,
        active.id,
        active.abort.signal,
      )
      active.abort.signal.throwIfAborted()
      return active.preflight.preview
    } finally {
      try {
        await this.release(active)
      } finally {
        active.admitted()
      }
    }
  }
  start = async (target: BrainLearningTarget, input: BrainLearningConsent): Promise<BrainJob> => {
    consentInput(input)
    const consent = structuredClone(input)
    const active = this.reserve()
    try {
      const flight = await learningPreflight(this.options, target, active.id, active.abort.signal)
      active.preflight = flight
      if (
        flight.preview.fingerprint !== consent.fingerprint ||
        flight.preview.policyEpoch !== consent.policyEpoch
      )
        throw new Error('Learning source, model, branch or consent changed; preview again')
      active.abort.signal.throwIfAborted()
      const request = this.request(active, consent)
      const { job, created } = await this.options.store.createLearning({
        jobId: active.id,
        scope: flight.preview.scope,
        branch: flight.preview.branch,
        target: flight.preview.target,
        binding: request.binding,
        checkpoint: flight.preview.checkpoint,
        covered: flight.prepared.checkpoint.covered,
        dependencyRootIds: flight.prepared.checkpoint.rootIds,
        dependencies: flight.prepared.checkpoint.source.entries.filter((entry) =>
          flight.prepared.checkpoint.rootIds.includes(entry.entryId),
        ),
        evidence: this.evidence(flight, request),
        expectedPolicyEpoch: consent.policyEpoch,
        ...(consent.retryJobId ? { retryJobId: consent.retryJobId } : {}),
      })
      if (!created) {
        await this.release(active)
        return job
      }
      active.job = job
      active.done = this.execute(active, request)
      active.done.catch((error: unknown) => this.options.report?.(error))
      return job
    } catch (error) {
      await this.release(active)
      throw error
    } finally {
      active.admitted()
    }
  }
  private reserve(): Active {
    if (this.closed || this.active) throw new Error('Learning is unavailable or busy')
    let admitted!: () => void
    const admission = new Promise<void>((resolve) => {
      admitted = resolve
    })
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(new Error('Learning deadline exceeded')), 120_000)
    const active = { id: (this.options.jobId ?? randomUUID)(), abort, admission, admitted, timer }
    this.active = active
    return active
  }
  private request(active: Active, consent: BrainLearningConsent): BrainLearningRequest {
    const flight = active.preflight!
    return structuredClone({
      version: 1,
      jobId: active.id,
      source: flight.prepared.checkpoint.source,
      binding: flight.prepared.binding,
      alreadyCovered: consent.retryJobId ? [] : flight.covered,
      suffixTimestamp: (this.options.now ?? Date.now)(),
      maxOutputTokens: flight.prepared.maxOutputTokens,
      deadlineMs: 120_000,
    })
  }
  private evidence(flight: LearningPreflight, request: BrainLearningRequest) {
    const known = new Set(request.alreadyCovered.map(learningDigest))
    return flight.prepared.evidence.map((item) => ({
      ...item,
      eligible: !known.has(
        learningDigest({ rootId: item.rootId, projectedHash: item.projectedHash }),
      ),
    }))
  }
  private assertResult(
    active: Active,
    request: BrainLearningRequest,
    result: BrainLearningResult,
  ): void {
    const flight = active.preflight!
    bounded(result, 4_000_000)
    if (
      result.version !== 1 ||
      result.jobId !== active.id ||
      learningDigest(result.binding) !== learningDigest(request.binding) ||
      learningDigest(result.checkpoint) !== learningDigest(flight.prepared.checkpoint) ||
      learningDigest(result.evidence) !== learningDigest(this.evidence(flight, request)) ||
      result.execution.logicalGenerations !== 1
    )
      throw new Error('Learning result does not match admitted source and binding')
  }
  private async assertAuthority(flight: LearningPreflight): Promise<void> {
    const current = await (this.options.authority ?? laneAuthority)(
      flight.preview.target.workspacePath,
    )
    if (current.scope !== flight.preview.scope || current.branch !== flight.preview.branch)
      throw new Error('Learning workspace authority changed')
  }
  private execute = async (active: Active, request: BrainLearningRequest): Promise<void> => {
    let usage: BrainLearningUsage | null = null
    try {
      active.job = await this.options.store.claimJob(active.id)
      active.abort.signal.throwIfAborted()
      const flight = active.preflight!
      await this.assertAuthority(flight)
      active.abort.signal.throwIfAborted()
      const result = await abortable(
        flight.prepared.run(request, active.abort.signal),
        active.abort.signal,
      )
      usage = failureUsage({ learningUsage: result.usage })
      this.assertResult(active, request, result)
      await this.assertAuthority(flight)
      active.abort.signal.throwIfAborted()
      await this.options.store.completeLearning(active.id, active.job.fence, {
        outcome: result.outcome,
        usage: result.usage,
      })
    } catch (error) {
      if (active.job)
        await this.options.store.failLearning(
          active.id,
          active.job.fence,
          active.abort.signal.aborted ? 'cancelled' : 'failed',
          (error instanceof Error ? error.message : 'Learning failed').slice(0, 2000),
          failureUsage(error) ?? usage,
        )
      this.options.report?.(error)
    } finally {
      await this.release(active)
    }
  }
  private async release(active: Active): Promise<void> {
    clearTimeout(active.timer)
    await active.preflight?.prepared.dispose()
    if (this.active === active) this.active = undefined
  }
  cancel = async (id: string): Promise<void> => {
    identifier(id)
    if (this.active?.id !== id) throw new Error('Learning job is not active')
    const active = this.active
    active.abort.abort(new Error('Learning cancelled'))
    await active.admission
    if (active.done) await active.done
  }
  /** Synchronous shutdown fence; owned disposal is awaited separately. */
  abort = (): void => {
    this.active?.abort.abort(new Error('Learning revoked'))
  }
  revoke = async (): Promise<void> => {
    const active = this.active
    if (active) await this.cancel(active.id)
  }
  dispose = async (): Promise<void> => {
    this.closed = true
    await this.revoke()
  }
}
