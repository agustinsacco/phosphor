/**
 * Drives the v7 engine: reads saved through the review flow, links as bare triples. Relate and
 * relation edits do not exist there and are refused.
 */
import type { Proposal } from '../types'
import { EngineBase, NOTE, type ConservationDriver, type Outcome } from './conservation-driver'
import type { ClaimSpec, LinkSpec } from './conservation-model'

interface V7Store {
  propose(value: Proposal): unknown
  decideRead(
    jobId: string,
    decision: {
      memories: number[]
      identities: Record<string, string>
      groups: number[]
      descriptions: string[]
      confirmations: number[]
    },
    expected: number,
    note: typeof NOTE,
  ): { operationId: string }
  correct(input: unknown, vector: Float32Array | null, note: typeof NOTE): unknown
}

export class V7Driver extends EngineBase implements ConservationDriver {
  private get v7(): V7Store {
    return this.store as unknown as V7Store
  }
  setup(groups: { lane: string; claims: ClaimSpec[]; create: string[] }[]): string[][] {
    return groups.map((group) => {
      const job = this.newJob(group.lane, false)
      if ('refused' in job) throw new Error(job.refused)
      const outcome = this.commit(job.id, group.lane, group.claims, group.create)
      if ('refused' in outcome) throw new Error(outcome.refused)
      return outcome.created
    })
  }
  private commit(jobId: string, lane: string, claims: ClaimSpec[], create: string[] = []) {
    const outcome = this.attempt(() => {
      const proposal = this.proposal(jobId, lane, claims, create)
      this.v7.propose(proposal)
      return this.v7.decideRead(
        jobId,
        {
          memories: claims.map((_, i) => i),
          identities: {},
          groups: [],
          descriptions: [],
          confirmations: [],
        },
        proposal.computedRevision,
        NOTE,
      ).operationId
    })
    if ('refused' in outcome) this.store.removeJob(jobId)
    else this.lastJob.set(lane, jobId)
    if ('refused' in outcome) return outcome
    return { ...outcome, created: this.createdInOrder(outcome.created, claims), job: jobId }
  }
  save(input: { lane: string; claims: ClaimSpec[]; reread: boolean }): Outcome {
    const job = this.newJob(input.lane, input.reread)
    if ('refused' in job) return job
    return this.commit(job.id, input.lane, input.claims)
  }
  fold(source: string, target: string): Outcome {
    return this.attempt(() =>
      this.store.resolve(
        this.openPair('same_memory', source, target),
        { kind: 'fold', survivorId: target },
        NOTE,
      ),
    )
  }
  merge(source: string, target: string): Outcome {
    return this.attempt(() =>
      this.store.agentEdit(
        { kind: 'merge', sourceId: this.entityId(source), targetId: this.entityId(target) },
        NOTE,
      ),
    )
  }
  correct(input: { memoryId: string; links: LinkSpec[]; ends: string[] }): Outcome {
    return this.attempt(() => {
      const result = this.v7.correct(
        {
          memoryId: input.memoryId,
          summary: `Corrected ${input.memoryId} at ${this.clock.time}.`,
          source: 'Linear KES-12',
          quote: 'The ticket says otherwise.',
        },
        null,
        NOTE,
      )
      return typeof result === 'string' ? result : (result as { operationId: string }).operationId
    })
  }
  replace(newer: string, older: string): Outcome {
    return this.attempt(() =>
      this.store.resolve(
        this.openPair('conflict', newer, older),
        { kind: 'replace', newerId: newer },
        NOTE,
      ),
    )
  }
  relate(): Outcome {
    return { refused: 'The v7 engine cannot state a link: at most none.' }
  }
  editRelation(): Outcome {
    return { refused: 'The v7 engine cannot edit a link: at most none.' }
  }
  forget(memoryId: string): Outcome {
    return this.attempt(() => {
      this.store.forget(memoryId)
      return null
    })
  }
  undo(operationId: string): Outcome {
    return this.attempt(() => {
      this.store.agentUndo(operationId, NOTE)
      return null
    })
  }
}
