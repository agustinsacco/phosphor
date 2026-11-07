import { createHash } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type {
  BrainCapture,
  BrainDelivery,
  BrainEvidence,
  BrainEvidencePage,
  BrainEvidenceSummary,
  BrainForgetResult,
} from '@phosphor/shared/brain'
import { type Data, identifier } from './data'
import * as validate from './validation'
import { forgetEntitySources } from './entities'
import { dependentEvidence, forgetLearning } from './learning-receipts'
import { excludedSource } from './source-exclusion'
import { expiredDependencyRoots } from './learning-dependencies'

export function blobName(evidence: Pick<BrainEvidence, 'id' | 'hash'>): string {
  return `${evidence.id}.${evidence.hash}.txt`
}
export class Evidence {
  constructor(readonly data: Data) {
    this.cleanOrphans()
  }
  cleanOrphans(): void {
    const live = new Set(this.data.all('evidence').map(blobName))
    for (const filename of readdirSync(this.data.blobs)) {
      if (!live.has(filename)) unlinkSync(join(this.data.blobs, filename))
    }
  }
  write(evidence: BrainEvidence): void {
    validate.check(
      this.data.count('evidence') < 10000,
      'Local evidence capacity reached; forget evidence before capturing more',
    )
    const path = join(this.data.blobs, blobName(evidence))
    const temporary = `${path}.tmp`
    const fd = openSync(temporary, 'wx', 0o600)
    try {
      writeFileSync(fd, evidence.text)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, path)
    const directory = openSync(this.data.blobs, 'r')
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
    const { text: _text, ...metadata } = evidence
    this.data.put('evidence', evidence.id, evidence.scope, metadata)
    this.data.db
      .prepare('INSERT OR IGNORE INTO retained VALUES (?,?)')
      .run(evidence.id, this.data.now())
  }
  capture(input: BrainCapture): BrainEvidence | null {
    validate.evidence(input)
    if (!this.data.enrolled(input.scope)) return null
    if (this.excluded(input.sessionId)) return null
    const id = identifier('evidence', input.scope, input.sessionId, input.entryId)
    const roots = [...new Set(input.rootIds)].sort()
    if (
      this.data.tombstoned(id) ||
      roots.some((root) => this.data.tombstoned(identifier('root', input.scope, root)))
    )
      return null
    const hash = createHash('sha256').update(input.text).digest('hex')
    const evidence: BrainEvidence = { ...input, id, hash, rootIds: roots }
    const existing = this.data.get('evidence', id)
    if (existing) {
      const { text: _text, ...metadata } = evidence
      validate.check(identifier(existing) === identifier(metadata), 'Evidence identity changed')
      return this.read(id, [input.scope])
    }
    this.data.transaction(() => this.write(evidence))
    return evidence
  }
  excluded(sessionId: string): boolean {
    return excludedSource(this.data, sessionId)
  }
  read(id: string, allowedScopes: string[]): BrainEvidence {
    validate.text(id)
    validate.strings(allowedScopes, 100)
    const evidence = this.data.require('evidence', id)
    this.data.consent(evidence.scope)
    validate.check(allowedScopes.includes(evidence.scope), 'Evidence outside allowed scopes')
    const path = join(this.data.blobs, blobName(evidence))
    const stat = lstatSync(path)
    validate.check(
      stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1_000_000,
      'Unsafe evidence blob',
    )
    const text = readFileSync(path, 'utf8')
    validate.check(
      createHash('sha256').update(text).digest('hex') === evidence.hash,
      'Evidence integrity failure',
    )
    return { ...evidence, text }
  }
  evidencePage(scope: string, afterId?: string): BrainEvidencePage {
    validate.text(scope)
    if (afterId !== undefined) {
      validate.check(
        typeof afterId === 'string' && /^[a-f0-9]{64}$/.test(afterId),
        'Invalid evidence cursor',
      )
    }
    this.data.consent(scope)
    const rows = this.data.db
      .prepare(
        `SELECT id,scope,json_extract(value,'$.label') AS label,
      json_extract(value,'$.role') AS role,json_extract(value,'$.observedAt') AS observed_at
      FROM documents WHERE kind='evidence' AND scope=? AND id>? ORDER BY id LIMIT 51`,
      )
      .all(scope, afterId ?? '')
    const items: BrainEvidenceSummary[] = rows.slice(0, 50).map((row) => ({
      id: String(row.id),
      scope: String(row.scope),
      label: String(row.label),
      role: row.role as BrainEvidenceSummary['role'],
      observedAt: Number(row.observed_at),
    }))
    return { items, nextCursor: rows.length > 50 ? items[49]!.id : null }
  }
  delivery(input: BrainDelivery): void {
    validate.bounded(input)
    validate.text(input.sessionId)
    validate.strings(input.evidenceIds)
    validate.strings(input.claimIds)
    for (const id of input.evidenceIds) this.data.consent(this.data.require('evidence', id).scope)
    for (const id of input.claimIds) this.data.consent(this.data.require('claims', id).scope)
    const old = this.data.get('deliveries', input.sessionId)
    this.data.put('deliveries', input.sessionId, '', {
      sessionId: input.sessionId,
      evidenceIds: [...new Set([...(old?.evidenceIds ?? []), ...input.evidenceIds])],
      claimIds: [...new Set([...(old?.claimIds ?? []), ...input.claimIds])],
    })
  }
  expire(): void {
    const cutoff = this.data.now() - this.data.prefs().retentionDays * 86_400_000
    for (let batch = 0; batch < 20; batch++) {
      const expired = this.data.db
        .prepare('SELECT id FROM retained WHERE retained_at<=? ORDER BY id LIMIT 500')
        .all(cutoff)
      const ids = expired.map((row) => String(row.id))
      const roots = expiredDependencyRoots(this.data, cutoff, ids)
      if (!ids.length && !roots.size) return
      this.forgetSources(ids, roots)
    }
    validate.check(
      !this.data.db.prepare('SELECT id FROM retained WHERE retained_at<=? LIMIT 1').get(cutoff) &&
        !this.data.db
          .prepare('SELECT job_id FROM learning_dependencies WHERE retained_at<=? LIMIT 1')
          .get(cutoff),
      'Expiry backlog; retry before serving memory',
    )
  }
  pendingPurges(): { jobId: string; sessionPath: string }[] {
    return this.data.all('purges')
  }
  acknowledgePurge(jobId: string): void {
    validate.text(jobId)
    this.data.remove('purges', jobId)
  }
  forget(ids: string[]): BrainForgetResult {
    validate.strings(ids, 500)
    return this.forgetSources(ids, new Set())
  }
  private forgetSources(ids: string[], initialRoots: Set<string>): BrainForgetResult {
    const selected = new Set(ids)
    const { removed, roots } = this.relatedEvidence(selected, initialRoots)
    const derived = new Set(
      this.data.db
        .prepare('SELECT claim_id,evidence_id FROM claim_sources')
        .all()
        .filter((row) => selected.has(String(row.evidence_id)))
        .map((row) => String(row.claim_id)),
    )
    const claims = this.data
      .all('claims')
      .filter(
        (claim) =>
          derived.has(claim.id) ||
          claim.citations.some((citation) => selected.has(citation.evidenceId)),
      )
    const claimIds = new Set(claims.map((claim) => claim.id))
    const affectedSessions = this.data
      .all('deliveries')
      .filter(
        (delivery) =>
          delivery.evidenceIds.some((id) => selected.has(id)) ||
          delivery.claimIds.some((id) => claimIds.has(id)),
      )
      .map((delivery) => delivery.sessionId)
    this.data.transaction(() => {
      for (const id of [...selected, ...roots]) this.data.tombstone(id)
      for (const evidence of removed) {
        this.data.remove('evidence', evidence.id)
        this.data.db.prepare('DELETE FROM retained WHERE id=?').run(evidence.id)
        this.data.db
          .prepare('DELETE FROM evidence_sources WHERE source_id=? OR derived_id=?')
          .run(evidence.id, evidence.id)
      }
      for (const claim of claims) {
        this.data.remove('claims', claim.id)
        this.data.db.prepare('DELETE FROM vectors WHERE claim_id=?').run(claim.id)
        this.data.db.prepare('DELETE FROM claim_fts WHERE id=?').run(claim.id)
        this.data.db.prepare('DELETE FROM claim_sources WHERE claim_id=?').run(claim.id)
        this.data.db.prepare('DELETE FROM claim_versions WHERE claim_id=?').run(claim.id)
      }
      forgetEntitySources(this.data, selected)
      this.invalidateDerived(selected, claimIds, roots)
      if (removed.length || claims.length) this.data.bump()
    })
    this.cleanOrphans()
    this.data.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    return { evidence: removed.length, claims: claims.length, affectedSessions }
  }
  private relatedEvidence(
    selected: Set<string>,
    roots: Set<string>,
  ): {
    removed: Omit<BrainEvidence, 'text'>[]
    roots: Set<string>
  } {
    const evidence = this.data.all('evidence')
    const originals = evidence.filter((item) => selected.has(item.id))
    for (const item of originals)
      for (const root of item.rootIds) roots.add(identifier('root', item.scope, root))
    // A multi-root derived copy is removed, but its other independent roots are not forgotten.
    const dependent = dependentEvidence(this.data, roots, selected)
    const removed = evidence.filter(
      (item) =>
        selected.has(item.id) ||
        dependent.has(item.id) ||
        item.rootIds.some((root) => roots.has(identifier('root', item.scope, root))),
    )
    for (const item of removed) selected.add(item.id)
    const children = new Map<string, string[]>()
    for (const row of this.data.db
      .prepare('SELECT source_id,derived_id FROM evidence_sources')
      .all()) {
      const values = children.get(String(row.source_id)) ?? []
      values.push(String(row.derived_id))
      children.set(String(row.source_id), values)
    }
    const byId = new Map(evidence.map((item) => [item.id, item]))
    for (let i = 0; i < removed.length; i++)
      for (const id of children.get(removed[i]!.id) ?? []) {
        if (!selected.has(id) && byId.has(id)) {
          selected.add(id)
          removed.push(byId.get(id)!)
        }
      }
    return { removed, roots }
  }
  private invalidateDerived(
    evidenceIds: Set<string>,
    claimIds: Set<string>,
    roots: Set<string>,
  ): void {
    for (const job of this.data.all('jobs')) {
      if (job.evidenceIds.some((id) => evidenceIds.has(id))) {
        if (job.learning) forgetLearning(this.data, job.id, roots)
        if (job.sessionPath)
          this.data.put('purges', job.id, job.scope, {
            jobId: job.id,
            sessionPath: job.sessionPath,
          })
        this.data.put('jobs', job.id, job.scope, {
          ...job,
          ...(job.learning ? { learning: { ...job.learning, outcome: null } } : {}),
          state: 'cancelled',
          sessionPath: null,
          evidenceIds: job.evidenceIds.filter((id) => !evidenceIds.has(id)),
          fence: job.fence + 1,
          updatedAt: this.data.now(),
          error: 'Evidence forgotten',
        })
      }
    }
    for (const proposal of this.data.all('proposals')) {
      if (
        proposal.input.entities.some((entity) =>
          entity.evidenceIds.some((id) => evidenceIds.has(id)),
        ) ||
        proposal.input.claims.some((claim) =>
          claim.citations.some((citation) => evidenceIds.has(citation.evidenceId)),
        )
      ) {
        this.data.remove('proposals', proposal.id)
      }
    }
    for (const claim of this.data.all('claims')) {
      if (claim.conflictIds.some((id) => claimIds.has(id))) {
        const conflictIds = claim.conflictIds.filter((id) => !claimIds.has(id))
        this.data.saveClaim({
          ...claim,
          conflictIds,
          state: claim.state === 'contested' && !conflictIds.length ? 'active' : claim.state,
          revision: claim.revision + 1,
        })
      }
    }
    const referenced = new Set(
      this.data
        .all('claims')
        .flatMap((claim) => [claim.subjectId, ...(claim.objectId ? [claim.objectId] : [])]),
    )
    for (const entity of this.data.all('entities'))
      if (!referenced.has(entity.id)) {
        this.data.remove('entities', entity.id)
        this.data.db.prepare('DELETE FROM entity_sources WHERE entity_id=?').run(entity.id)
      }
  }
}
