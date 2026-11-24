import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import type { AgentOpRow } from '@phosphor/shared/ops'
import { OP_CATALOG } from '@phosphor/shared/ops-catalog'
import { loadSqlite } from '../sqlite'
import { AGENT_OPS_SCHEMA, createAuditLog, type AuditExtras } from './audit'
import { createUndo, undoRecordFor, type UndoPorts } from './undo'
import type { OpPrincipal } from './types'

const specFor = (name: string) => OP_CATALOG.find((op) => op.name === name)
const spec = (name: string) => {
  const found = specFor(name)
  if (!found) throw new Error(`no catalog op ${name}`)
  return found
}

describe('undoRecordFor', () => {
  it('has no Undo without a catalog inverse, or when the inverse declines', () => {
    expect(undoRecordFor(spec('lane.list'), {}, undefined, specFor)).toBeNull()
    expect(undoRecordFor(spec('lane.rename'), { ref: 'r', name: 'n' }, 'gone', specFor)).toBeNull()
  })

  it('stores the inverse and, when nothing is redacted, the change’s own args', () => {
    expect(
      undoRecordFor(
        spec('lane.rename'),
        { ref: 'r', name: 'New' },
        { ref: 'r', name: 'Old' },
        specFor,
      ),
    ).toEqual({
      inverse: { op: 'lane.rename', args: { ref: 'r', name: 'Old' } },
      forward: { ref: 'r', name: 'New' },
    })
    const add = { name: 'n', scope: 'global', config: { url: 'https://h.example/x' } }
    expect(undoRecordFor(spec('mcp.add'), add, undefined, specFor)).toEqual({
      inverse: { op: 'mcp.remove', args: { name: 'n', scope: 'global' } },
    })
  })

  it('has no Undo when the inverse would hold a secret or free text', () => {
    const before = { name: 'n', scope: 'global', config: { headers: { Authorization: 'x' } } }
    expect(undoRecordFor(spec('mcp.update'), before, before, specFor)).toBeNull()
    expect(
      undoRecordFor(
        spec('instructions.edit'),
        { content: 'new', revision: 'r2' },
        { content: 'old', revision: 'r1' },
        specFor,
      ),
    ).toBeNull()
    expect(
      undoRecordFor(spec('lane.rename'), { ref: 'r', name: 'n' }, { ref: 'r' }, () => undefined),
    ).toBeNull()
    const throwing = { ...spec('lane.rename'), inverse: () => JSON.parse('{') as never }
    expect(undoRecordFor(throwing, { ref: 'r', name: 'n' }, {}, specFor)).toBeNull()
  })
})

const dbs: DatabaseSync[] = []
afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
})
const surface: OpPrincipal = { kind: 'surface', clientId: 'c1', label: 'MacBook', via: 'owner' }

function setup(isCurrent: UndoPorts['isCurrent'] = () => Promise.resolve(true)) {
  const db = new (loadSqlite().DatabaseSync)(':memory:')
  db.exec(AGENT_OPS_SCHEMA)
  dbs.push(db)
  const audit = createAuditLog(db, { now: () => 10 })
  const run = vi.fn<UndoPorts['run']>(() =>
    Promise.resolve({ status: 'ok', text: 'Renamed.', applies: 'now', auditId: 'undo-row' }),
  )
  const check = vi.fn(isCurrent)
  const undo = createUndo({ audit, isCurrent: check, run })
  const append = (patch: Partial<Omit<AgentOpRow, 'id'>> & AuditExtras = {}) =>
    audit.append({
      at: 1,
      principal: 'agent:s1',
      op: 'lane.rename',
      tier: 'lane',
      scope: 'self',
      argsSummary: '{}',
      decision: 'allowed',
      result: 'ok',
      undo: true,
      undoRecord: { inverse: { op: 'lane.rename', args: { ref: 'r', name: 'Old' } } },
      ...patch,
    })
  return { audit, run, check, undo, append }
}

describe('createUndo', () => {
  it('runs the inverse as the user and links the row to the undo', async () => {
    const s = setup()
    const id = await s.append()
    expect(await s.undo(surface, id)).toMatchObject({ status: 'ok', auditId: 'undo-row' })
    expect(s.run).toHaveBeenCalledWith(surface, {
      op: 'lane.rename',
      args: { ref: 'r', name: 'Old' },
      reason: `Undo of lane.rename (${id})`,
    })
    expect(s.audit.get(id)).toMatchObject({ undo: false, undoneBy: 'undo-row' })
    expect(await s.undo(surface, id)).toMatchObject({ status: 'denied', code: 'unavailable' })
  })

  it('is a surface action only', async () => {
    const s = setup()
    const id = await s.append()
    const others: OpPrincipal[] = [
      { kind: 'agent', laneRef: 'l', sessionId: 's1', unattended: false, lineage: 0 },
      { kind: 'machine', machineId: 'm', clientId: 'c', label: 'stark', lane: null },
      { kind: 'local', clientId: 'cli' },
    ]
    for (const p of others)
      expect(await s.undo(p, id)).toMatchObject({ status: 'denied', code: 'forbidden' })
    expect(s.run).not.toHaveBeenCalled()
  })

  it('refuses an unknown row, a refused change and a change without Undo', async () => {
    const s = setup()
    expect(await s.undo(surface, 'missing')).toMatchObject({ code: 'bad-request' })
    const refused = await s.append({ decision: 'denied-policy' })
    expect(await s.undo(surface, refused)).toMatchObject({ code: 'unavailable' })
    const plain = await s.append({ undo: false })
    expect(await s.undo(surface, plain)).toMatchObject({ code: 'unavailable' })
    expect(s.run).not.toHaveBeenCalled()
  })

  it('refuses when the state changed since, or the check fails', async () => {
    const changed = setup(() => Promise.resolve(false))
    const id = await changed.append()
    expect(await changed.undo(surface, id)).toMatchObject({ code: 'unavailable' })
    expect(changed.check).toHaveBeenCalledWith(
      expect.objectContaining({ id, undoRecord: expect.objectContaining({}) }),
    )
    const failing = setup(() => Promise.reject(new Error('read failed')))
    const other = await failing.append()
    expect(await failing.undo(surface, other)).toMatchObject({ code: 'unavailable' })
    expect(changed.run).not.toHaveBeenCalled()
    expect(failing.run).not.toHaveBeenCalled()
  })

  it('never runs two undos of one row at once, and keeps a failed undo retryable', async () => {
    let release: (r: OpsRunResult) => void = () => undefined
    const s = setup()
    s.run.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
    const id = await s.append()
    const first = s.undo(surface, id)
    await vi.waitFor(() => expect(s.run).toHaveBeenCalledTimes(1))
    expect(await s.undo(surface, id)).toMatchObject({ code: 'busy' })
    release({ status: 'denied', code: 'busy', text: 'A turn is running.' })
    expect(await first).toMatchObject({ status: 'denied' })
    expect(s.audit.get(id)).toMatchObject({ undo: true })
    expect(await s.undo(surface, id)).toMatchObject({ status: 'ok' })
  })
})
