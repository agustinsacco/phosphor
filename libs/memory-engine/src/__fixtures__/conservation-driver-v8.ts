/**
 * Drives the v8 engine: reads saved by saveRead, links with wording, dates and speaker, Brain
 * Agent's relate and relation edits, and correct with its links and ends.
 */
import type { BrainLinkInput } from '@phosphor/shared/brain-agent'
import { day, EngineBase, NOTE, type ConservationDriver, type Outcome } from './conservation-driver'
import type { ClaimSpec, LinkSpec } from './conservation-model'

export class V8Driver extends EngineBase implements ConservationDriver {
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
    this.store.updateJob(jobId, { state: 'running', startedAt: this.clock.time })
    const outcome = this.attempt(
      () => this.store.saveRead(this.proposal(jobId, lane, claims, create)).operationId,
    )
    if ('refused' in outcome) {
      this.store.removeJob(jobId)
      return outcome
    }
    this.lastJob.set(lane, jobId)
    return { ...outcome, created: this.createdInOrder(outcome.created, claims), job: jobId }
  }
  private linkInput(link: LinkSpec): BrainLinkInput {
    return {
      subjectId: this.entityId(link.s),
      predicate: link.p,
      objectId: this.entityId(link.o),
      label: link.label,
      since: link.vf === null ? null : day(link.vf),
      until: link.vt === null ? null : day(link.vt),
    }
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
    return this.attempt(
      () =>
        this.store.correct(
          {
            memoryId: input.memoryId,
            summary: `Corrected ${input.memoryId} at ${this.clock.time}.`,
            source: 'Linear KES-12',
            quote: 'The ticket says otherwise.',
            links: input.links.map((link) => this.linkInput(link)),
            ends: input.ends.map((key) => this.relationId(input.memoryId, key)),
          },
          null,
          NOTE,
        ).operationId,
    )
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
  relate(input: { host: string; link: LinkSpec }): Outcome {
    return this.attempt(() =>
      this.store.relate({ ...this.linkInput(input.link), memoryIds: [input.host] }, NOTE),
    )
  }
  editRelation(input: {
    host: string
    key: string
    patch: Partial<Pick<LinkSpec, 'label' | 'vf' | 'vt'>>
  }): Outcome {
    const { label, vf, vt } = input.patch
    return this.attempt(() =>
      this.store.agentEdit(
        {
          kind: 'relation',
          relationId: this.relationId(input.host, input.key),
          ...(label === undefined ? {} : { label }),
          ...(vf === undefined ? {} : { since: vf === null ? null : day(vf) }),
          ...(vt === undefined ? {} : { until: vt === null ? null : day(vt) }),
        },
        NOTE,
      ),
    )
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
