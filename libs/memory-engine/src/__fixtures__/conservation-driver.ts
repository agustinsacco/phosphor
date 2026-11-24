/**
 * What the conservation property test asks of an engine, and the parts every driver shares: a
 * store on a frozen clock, proposals built from claim specs, and the facts read back.
 */
import { DatabaseSync } from 'node:sqlite'
import type { BrainEntityKind } from '@phosphor/shared/brain'
import { openBrainStore } from '../store'
import { pairKey } from '../tidy/suggestions'
import type { BrainStore, Proposal } from '../types'
import type { ClaimSpec, LinkSpec } from './conservation-model'

export type Outcome =
  { operationId: string | null; created: string[]; job?: string } | { refused: string }
export interface ConservationDriver {
  save(input: { lane: string; claims: ClaimSpec[]; reread: boolean }): Outcome
  fold(source: string, target: string): Outcome
  merge(source: string, target: string): Outcome
  correct(input: { memoryId: string; links: LinkSpec[]; ends: string[] }): Outcome
  replace(newer: string, older: string): Outcome
  relate(input: { host: string; link: LinkSpec }): Outcome
  editRelation(input: {
    host: string
    key: string
    patch: Partial<Pick<LinkSpec, 'label' | 'vf' | 'vt'>>
  }): Outcome
  forget(memoryId: string): Outcome
  undo(operationId: string): Outcome
  /** Links on current memories, detailed or as bare triples, sorted. */
  facts(detail: boolean): string[]
  currentIds(): string[]
}
export const ENTITY_KINDS: Record<string, BrainEntityKind> = {
  'Rina Okafor': 'person',
  'Tom Lee': 'person',
  'Mara Voss': 'person',
  Harbor: 'component',
  Ledger: 'project',
  Northwind: 'organization',
}
export const NOTE = { runId: null, reason: 'The property test checks this change.' }
/** Refusals an engine may answer; anything else (a constraint, a missing row) fails the test. */
const ALLOWED =
  /no longer current|cannot be folded|Resolve the history|already disputed|Later changes|no longer available|already undone|Choose two different|already linked|already queued|Only finished|does not apply|no longer active|link this way|can't be undone|can't be brought back|at most/iu

export const day = (at: number): string => new Date(at).toISOString().slice(0, 10)

export class EngineBase {
  readonly clock = { time: 1_700_006_400_000 }
  readonly db: DatabaseSync
  readonly store: BrainStore
  readonly lastJob = new Map<string, string>()
  private leaf = 0
  private vectors = 0
  constructor() {
    let counter = 0,
      db: DatabaseSync | undefined
    class Database extends DatabaseSync {
      constructor(path: string, options?: { timeout?: number }) {
        super(path, options ?? {})
        db = this
      }
    }
    this.store = openBrainStore({
      path: ':memory:',
      Database,
      now: () => this.clock.time,
      id: () => `id-${String(++counter).padStart(6, '0')}`,
    })
    this.db = db!
  }
  close(): void {
    this.store.close()
  }
  entityId(name: string): string {
    const row = this.db.prepare('SELECT id FROM entities WHERE label=?').get(name)
    if (!row) throw new Error(`Brain entity not found: ${name}`)
    return String(row.id)
  }
  memoryIds(): Set<string> {
    return new Set(
      this.db
        .prepare('SELECT id FROM memories')
        .all()
        .map((r) => String(r.id)),
    )
  }
  currentIds(): string[] {
    return this.db
      .prepare("SELECT id FROM memories WHERE state IN ('active','disputed') ORDER BY id")
      .all()
      .map((r) => String(r.id))
  }
  relationId(host: string, key: string): string {
    const [s, p, o] = key.split('|')
    const row = this.db
      .prepare(
        `SELECT r.n FROM relations r JOIN memories m ON m.n=r.memory JOIN entities s ON s.n=r.subject
        JOIN entities o ON o.n=r.object WHERE m.id=? AND s.label=? AND r.predicate=? AND o.label=?`,
      )
      .get(host, s!, p!, o!)
    return String(row!.n)
  }
  facts(detail: boolean): string[] {
    return this.db
      .prepare(
        `SELECT s.label AS s,r.predicate AS p,o.label AS o,r.label,r.valid_from AS vf,r.valid_to AS vt,
        r.stated_by AS by,r.live FROM relations r JOIN memories m ON m.n=r.memory
        JOIN entities s ON s.n=r.subject JOIN entities o ON o.n=r.object
        WHERE m.state IN ('active','disputed')`,
      )
      .all()
      .map((r) =>
        detail
          ? `${r.s}|${r.p}|${r.o}|${r.label}|${r.vf}|${r.vt}|${r.by}|${r.live ? 'live' : 'dead'}`
          : `${r.s}|${r.p}|${r.o}`,
      )
      .sort()
  }
  /** Runs a write; an allowed refusal changes nothing, any other error fails the test. */
  attempt(write: () => string | null): Outcome {
    const before = this.memoryIds()
    try {
      const operationId = write()
      return { operationId, created: [...this.memoryIds()].filter((id) => !before.has(id)) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (ALLOWED.test(message)) return { refused: message }
      throw error
    }
  }
  /** A pair suggestion of `kind`, open, so a curator action can settle it. */
  openPair(kind: 'same_memory' | 'conflict', first: string, second: string): string {
    const key = pairKey('memory', first, second)
    this.db.prepare('DELETE FROM tidy_suggestions WHERE pair_key=?').run(key)
    const id = `pair-${first}-${second}-${this.clock.time}`
    this.db
      .prepare(
        `INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,created_at,updated_at)
        VALUES (?,?,?,'sweep','open','memory',?,?,'Planted by the property test.',?,?)`,
      )
      .run(id, key, kind, first, second, this.clock.time, this.clock.time)
    return id
  }
  newJob(lane: string, reread: boolean): { id: string } | { refused: string } {
    try {
      const replaces = reread ? (this.lastJob.get(lane) ?? null) : null
      if (reread && !replaces) return { refused: 'Only finished reads can be read again.' }
      return this.store.enqueue(
        {
          sessionId: lane,
          sessionPath: `/made-up/${lane}.jsonl`,
          title: lane,
          scope: '/projects/harbor',
          branch: null,
          model: 'made-up/model',
          leafId: `leaf-${++this.leaf}`,
          replaces,
        },
        'queued',
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (ALLOWED.test(message)) return { refused: message }
      throw error
    }
  }
  /** Claims citing one evidence row each; names in `create` become new entities. */
  proposal(jobId: string, lane: string, claims: ClaimSpec[], create: string[] = []): Proposal {
    const ref = (name: string) => (create.includes(name) ? name : this.entityId(name))
    const vector = () => {
      const result = new Float32Array(768)
      const n = ++this.vectors
      result[n % 768] = 1
      result[(n * 7 + 3) % 768] = 1
      return result
    }
    return {
      jobId,
      origin: { sessionId: lane, title: lane },
      scope: '/projects/harbor',
      branch: null,
      computedRevision: this.store.knowledgeRevision(),
      entities: create.map((name) => ({
        ref: name,
        label: name,
        kind: ENTITY_KINDS[name]!,
        aliases: [],
        description: '',
        keys: [],
        decision: 'new' as const,
        entityId: null,
        candidates: [],
        reason: '',
        auto: true,
      })),
      memories: claims.map((claim, i) => ({
        summary: claim.summary,
        type: 'fact' as const,
        kind: 'reported' as const,
        entities: claim.entities.map(ref),
        links: claim.links.map((link) => ({
          subject: ref(link.s),
          predicate: link.p,
          object: ref(link.o),
          citation: { evidence: i, quote: claim.summary },
          label: link.label,
          validFrom: link.vf,
          validTo: link.vt,
        })),
        branch: false,
        validFrom: claim.validFrom,
        validTo: null,
        citations: [{ evidence: i, quote: claim.summary }],
        action: claim.target ? ('supersede' as const) : ('add' as const),
        target: claim.target,
        reason: '',
      })),
      groups: [],
      confirmations: [],
      evidence: claims.map((claim, i) => ({
        sessionId: lane,
        entryId: `${jobId}-${i}`,
        role: 'user' as const,
        label: 'You',
        observedAt: this.clock.time,
        text: claim.summary,
      })),
      held: 0,
      memoryVectors: claims.map(vector),
      entityVectors: create.map(vector),
    }
  }
  /** New memory ids in claim order, matched by their unique summaries. */
  createdInOrder(created: string[], claims: ClaimSpec[]): string[] {
    const bySummary = new Map(
      created.map((id) => [
        String(this.db.prepare('SELECT summary FROM memories WHERE id=?').get(id)!.summary),
        id,
      ]),
    )
    return claims.map((claim) => bySummary.get(claim.summary)!)
  }
}
