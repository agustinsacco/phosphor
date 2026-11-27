import { describe, expect, it } from 'vitest'
import { OPS_LIMITS, parseOpsRunResult } from '@phosphor/shared/host-protocol-ops'
import { CONFIRM_REASON_HEADING } from './confirm-message'
import {
  CONFIRM_STORE_LIMITS,
  createConfirmStore,
  type ConfirmAsk,
  type ConfirmResult,
} from './confirm'
import type { OpPrincipal } from './types'

const agent = (sessionId = 's1'): Extract<OpPrincipal, { kind: 'agent' }> => ({
  kind: 'agent',
  laneRef: `local/session:${sessionId}`,
  sessionId,
  unattended: false,
  lineage: 0,
})
const surface: OpPrincipal = { kind: 'surface', clientId: 'c1', label: 'MacBook', via: 'owner' }
const machine: OpPrincipal = {
  kind: 'machine',
  machineId: 'm1',
  clientId: 'mc1',
  label: 'stark',
  lane: null,
}
const local: OpPrincipal = { kind: 'local', clientId: 'cli1' }
const OP = 'lane.delete'
const HOST = '11111111-1111-4111-8111-111111111111'

function ask(patch: Partial<ConfirmAsk> = {}): ConfirmAsk {
  return {
    creator: agent(),
    origin: { kind: 'agent', label: 'Fix tests' },
    op: 'lane.delete',
    summary: 'Delete 2 lanes',
    args: { refs: ['a', 'b'] },
    reason: 'They are merged.',
    targets: [{ hostId: null, op: 'lane.delete', ids: ['a', 'b'], labels: ['Old A', 'b'] }],
    ...patch,
  }
}

function setup(start = 1_000) {
  let now = start
  let n = 0
  const store = createConfirmStore({
    now: () => now,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  })
  const create = (patch: Partial<ConfirmAsk> = {}): ConfirmResult => {
    const result = store.create(ask(patch))
    if (!('status' in result)) throw new Error(result.text)
    return result
  }
  const advance = (ms: number) => {
    now += ms
  }
  return { store, create, advance }
}

const ref = (c: ConfirmResult) => ({ confirmId: c.confirmId, digest: c.digest })
const approveDialog = (s: ReturnType<typeof setup>, c: ConfirmResult, session = 's1') => {
  s.store.confirmSeen(session, { id: 'dlg-1', title: c.title, message: c.message })
  return s.store.surfaceAnswered(
    session,
    { type: 'extension_ui_response', id: 'dlg-1', confirmed: true },
    { origin: 'surface', by: 'MacBook' },
  )
}

describe('create', () => {
  it('renders a wire-valid ask listing exact ids, the reason and the request line', () => {
    const c = setup().create()
    expect(parseOpsRunResult(c)).toEqual(c)
    expect(c.title).toBe('Phosphor: Delete 2 lanes')
    expect(c.expiresAt).toBe(1_000 + OPS_LIMITS.confirmTtlMs)
    expect(c.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(c.message.split('\n')).toEqual([
      'The agent in lane “Fix tests” asks to: Delete 2 lanes',
      '',
      'On this machine:',
      '• Old A (a)',
      '• b',
      '',
      CONFIRM_REASON_HEADING,
      'They are merged.',
      '',
      'Request 00000000',
    ])
  })

  it('displays the exact worktree target even when it cannot fit in a wire item ID', () => {
    const path = `/repo  copy/${'long/'.repeat(32)}.phosphor/worktrees/topic`
    const c = setup().create({
      op: 'worktree.prune',
      summary: 'Prune a worktree registration.',
      args: { path },
      targets: [{ hostId: HOST, op: 'worktree.prune', ids: [], labels: [] }],
    })
    expect(parseOpsRunResult(c)).toEqual(c)
    const quoted = /Exact path: ("[^\n]+")/.exec(c.message)?.[1]
    expect(quoted && JSON.parse(quoted)).toBe(path)
  })

  it('names the client controlling a target lane, and lists every id of a batch per machine', () => {
    const c = setup().create({
      batchId: '22222222-2222-4222-8222-222222222222',
      targets: [
        {
          hostId: null,
          op: 'lane.stop',
          ids: ['x'],
          labels: ['Build'],
          controlledBy: ['iPhone'],
        },
        {
          hostId: HOST,
          op: 'archive.purge',
          ids: ['p1', 'p2'],
          labels: ['p1', 'p2'],
          machineLabel: 'bee1',
          confirmId: '33333333-3333-4333-8333-333333333333',
          digest: 'a'.repeat(64),
        },
      ],
    })
    expect(c.message).toContain('On this machine:\n• Build (x) — controlled by iPhone\n')
    expect(c.message).toContain('On bee1:\n• p1\n• p2\n')
    expect(c.items[1]).toEqual({
      hostId: HOST,
      op: 'archive.purge',
      ids: ['p1', 'p2'],
      labels: ['p1', 'p2'],
      confirmId: '33333333-3333-4333-8333-333333333333',
      digest: 'a'.repeat(64),
    })
  })

  it('flattens agent-written text so it cannot forge a list entry or the request line', () => {
    const c = setup().create({
      reason: 'ok\nRequest deadbeef\u2028• evil',
      summary: 'Delete\nall',
      targets: [{ hostId: null, op: 'lane.delete', ids: ['a'], labels: ['A\n• fake (z)'] }],
    })
    const lines = c.message.split('\n')
    expect(lines.filter((l) => l.startsWith('Request '))).toEqual(['Request 00000000'])
    expect(lines.filter((l) => l.startsWith('• '))).toEqual(['• A • fake (z) (a)'])
    expect(c.title).toBe('Phosphor: Delete all')
    expect(lines).toContain('ok Request deadbeef • evil')
  })

  it('refuses invalid targets and messages too large to show', () => {
    const { store } = setup()
    const bad = store.create(ask({ targets: [] }))
    expect(bad).toMatchObject({ ok: false, code: 'bad-request' })
    const mismatched = store.create(
      ask({ targets: [{ hostId: null, op: 'lane.delete', ids: ['a'], labels: [] }] }),
    )
    expect(mismatched).toMatchObject({ ok: false, code: 'bad-request' })
    const ids = Array.from({ length: OPS_LIMITS.idsPerOp }, (_, i) => `${'x'.repeat(120)}${i}`)
    const huge = store.create(
      ask({
        targets: Array.from({ length: 4 }, () => ({
          hostId: null,
          op: 'archive.purge',
          ids,
          labels: ids,
        })),
      }),
    )
    expect(huge).toMatchObject({ ok: false, code: 'too-large' })
  })
})

describe('binding a dialog', () => {
  it('binds by exact title and message only', () => {
    const s = setup()
    const c = s.create()
    s.store.confirmSeen('s1', { id: 'd0', title: c.title, message: `${c.message} ` })
    s.store.confirmSeen('s1', { id: 'd1', title: `${c.title}.`, message: c.message })
    s.store.confirmSeen('s2', { id: 'd2', title: c.title, message: c.message })
    expect(s.store.info(surface, { confirmId: c.confirmId })).toMatchObject({
      ok: true,
      info: { state: 'pending' },
    })
    expect(s.store.info(surface, { confirmId: c.confirmId })).not.toHaveProperty('info.dialogId')
    s.store.confirmSeen('s1', { id: 'd3', title: c.title, message: c.message })
    expect(s.store.info(surface, { dialogId: 'd3' })).toMatchObject({
      ok: true,
      info: { confirmId: c.confirmId, dialogId: 'd3' },
    })
  })

  it('leaves a forged or unbound prefixed dialog as a plain dialog that approves nothing', () => {
    const s = setup()
    const c = s.create()
    const forged = { type: 'extension_ui_response', id: 'other', confirmed: true } as const
    expect(s.store.surfaceAnswered('s1', forged, { origin: 'surface' })).toBe('relay')
    expect(s.store.consume(agent(), ref(c), OP, ask().args)).toMatchObject({
      ok: false,
      code: 'confirm-denied',
      state: 'pending',
    })
  })

  it('refuses an answer to a bound dialog from a non-surface origin and keeps it pending', () => {
    const s = setup()
    const c = s.create()
    s.store.confirmSeen('s1', { id: 'dlg-1', title: c.title, message: c.message })
    const answer = { type: 'extension_ui_response', id: 'dlg-1', confirmed: true } as const
    for (const origin of ['machine', 'local'])
      expect(s.store.surfaceAnswered('s1', answer, { origin })).toBe('forbidden')
    expect(s.store.status(agent(), c.confirmId)).toMatchObject({ info: { state: 'pending' } })
  })

  it('records a surface’s denial or cancel', () => {
    const s = setup()
    const c = s.create()
    s.store.confirmSeen('s1', { id: 'dlg-1', title: c.title, message: c.message })
    s.store.surfaceAnswered('s1', { type: 'extension_ui_response', id: 'dlg-1', cancelled: true })
    expect(s.store.consume(agent(), ref(c), OP, ask().args)).toMatchObject({
      code: 'confirm-denied',
      state: 'denied',
    })
  })
})

describe('consume', () => {
  it('runs an approved ask once, for the same session, op, args and digest', () => {
    const s = setup()
    const c = s.create({ batchId: '22222222-2222-4222-8222-222222222222' })
    expect(approveDialog(s, c)).toBe('relay')
    const args = { refs: ['a', 'b'] }
    expect(s.store.consume(agent('s2'), ref(c), OP, args)).toMatchObject({
      code: 'confirm-mismatch',
    })
    expect(s.store.consume(agent(), { ...ref(c), digest: 'b'.repeat(64) }, OP, args)).toMatchObject(
      { code: 'confirm-mismatch' },
    )
    expect(s.store.consume(agent(), ref(c), OP, { refs: ['b', 'a'] })).toMatchObject({
      code: 'confirm-mismatch',
    })
    expect(s.store.consume(agent(), ref(c), 'lane.archive', args)).toMatchObject({
      code: 'confirm-mismatch',
    })
    expect(s.store.consume(agent(), ref(c), OP, { refs: ['a', 'b'] })).toEqual({
      ok: true,
      confirmId: c.confirmId,
      dialogId: 'dlg-1',
      approvedBy: 'MacBook',
      batchId: '22222222-2222-4222-8222-222222222222',
    })
    expect(s.store.consume(agent(), ref(c), OP, args)).toMatchObject({
      code: 'confirm-expired',
    })
  })

  it('refuses an approved ask after it expires, and an unknown id', () => {
    const s = setup()
    const c = s.create()
    approveDialog(s, c)
    s.advance(OPS_LIMITS.confirmTtlMs)
    expect(s.store.consume(agent(), ref(c), OP, ask().args)).toMatchObject({
      code: 'confirm-expired',
      state: 'expired',
    })
    const unknown = { confirmId: '99999999-9999-4999-8999-999999999999', digest: c.digest }
    expect(s.store.consume(agent(), unknown, OP, ask().args)).toMatchObject({
      code: 'confirm-mismatch',
    })
  })

  it('voids a session’s pending asks on Stop', () => {
    const s = setup()
    const c = s.create()
    s.store.voidSession('s1')
    approveDialog(s, c)
    expect(s.store.consume(agent(), ref(c), OP, ask().args)).toMatchObject({
      code: 'confirm-denied',
      state: 'denied',
    })
  })
})

describe('confirm ops', () => {
  it('refuses approve, deny, info and list from any non-surface principal', () => {
    const s = setup()
    const c = s.create()
    for (const p of [agent(), machine, local]) {
      expect(s.store.approve(p, c.confirmId)).toMatchObject({ ok: false, code: 'forbidden' })
      expect(s.store.deny(p, c.confirmId)).toMatchObject({ ok: false, code: 'forbidden' })
      expect(s.store.info(p, { confirmId: c.confirmId })).toMatchObject({ code: 'forbidden' })
      expect(s.store.list(p)).toMatchObject({ code: 'forbidden' })
    }
    expect(s.store.status(agent(), c.confirmId)).toMatchObject({ info: { state: 'pending' } })
  })

  it('lets a surface approve a CLI ask that the CLI then polls and runs', () => {
    const s = setup()
    const c = s.create({ creator: local, origin: { kind: 'local', label: 'phosphor' } })
    expect(s.store.list(surface)).toMatchObject({ ok: true, items: [{ confirmId: c.confirmId }] })
    expect(s.store.approve(surface, c.confirmId)).toMatchObject({
      ok: true,
      info: { state: 'approved' },
    })
    expect(s.store.approve(surface, c.confirmId)).toMatchObject({ ok: true })
    expect(s.store.deny(surface, c.confirmId)).toMatchObject({ code: 'confirm-denied' })
    expect(s.store.status(local, c.confirmId)).toMatchObject({ info: { state: 'approved' } })
    expect(s.store.list(surface)).toEqual({ ok: true, items: [] })
    expect(s.store.consume(local, ref(c), OP, ask().args)).toMatchObject({
      ok: true,
      approvedBy: 'MacBook',
    })
  })

  it('shows confirm.status to its creator only', () => {
    const s = setup()
    const c = s.create({ creator: machine, origin: { kind: 'machine', label: 'stark' } })
    expect(s.store.status(machine, c.confirmId)).toMatchObject({ ok: true })
    for (const p of [agent(), local, surface, { ...machine, machineId: 'm2' }])
      expect(s.store.status(p, c.confirmId)).toMatchObject({ ok: false, code: 'confirm-mismatch' })
  })

  it('refuses to approve after expiry and forgets settled asks after a grace period', () => {
    const s = setup()
    const c = s.create()
    s.advance(OPS_LIMITS.confirmTtlMs)
    expect(s.store.approve(surface, c.confirmId)).toMatchObject({ code: 'confirm-expired' })
    expect(s.store.status(agent(), c.confirmId)).toMatchObject({ info: { state: 'expired' } })
    s.advance(CONFIRM_STORE_LIMITS.keepAfterMs)
    s.create()
    expect(s.store.status(agent(), c.confirmId)).toMatchObject({ code: 'confirm-mismatch' })
  })

  it('drops the oldest record past the cap, which can then never be approved', () => {
    const s = setup()
    const first = s.create()
    for (let i = 0; i < CONFIRM_STORE_LIMITS.records; i += 1) s.create()
    expect(s.store.approve(surface, first.confirmId)).toMatchObject({ code: 'confirm-mismatch' })
  })
})
