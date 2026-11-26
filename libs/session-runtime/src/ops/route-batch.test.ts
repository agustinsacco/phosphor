import { describe, expect, it } from 'vitest'
import type { OpsRunRequest, OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import { CONFIRM_STORE_LIMITS, confirmPort, createConfirmStore } from './confirm'
import { createRouteBatches, ROUTE_BATCH_LIMITS } from './route-batch'
import {
  createHarness,
  DIGEST,
  surface,
  type HarnessOptions,
} from './__fixtures__/dispatcher-harness'

const BEE1 = 'b1b1b1b1-0000-4000-8000-000000000001'
const BEE2 = 'b2b2b2b2-0000-4000-8000-000000000002'
const BEE3 = 'b3b3b3b3-0000-4000-8000-000000000003'
const LABELS: Record<string, string> = { [BEE1]: 'bee1', [BEE2]: 'bee2', [BEE3]: 'bee3' }
const resolver: NonNullable<HarnessOptions['hosts']> = {
  resolve: async (hosts) => ({
    ok: true,
    hosts: (hosts === 'all' ? Object.keys(LABELS) : hosts).map((id) => ({
      id,
      label: LABELS[id] ?? id,
    })),
  }),
}

const targetConfirm = (n: number): string => `${n}${n}${n}${n}0000-1111-4111-8111-11111111111${n}`
const ok = (text: string): OpsRunResult => ({ status: 'ok', text, applies: 'now' })

/** A sibling that asks on the first submission and runs on the one carrying its own confirm. */
function asking(n: number, ids: readonly string[], run: () => OpsRunResult = () => ok('purged')) {
  return async (request: OpsRunRequest): Promise<OpsRunResult> => {
    if (!request.confirm)
      return {
        status: 'confirm',
        confirmId: targetConfirm(n),
        digest: DIGEST,
        title: 'Phosphor: Purge archived lanes.',
        message: `On this machine:\n${ids.map((id) => `• ${id}`).join('\n')}`,
        items: [{ hostId: null, op: 'archive.purge', ids, labels: ids }],
        expiresAt: 2_000_000,
      }
    if (request.confirm.confirmId !== targetConfirm(n) || request.confirm.digest !== DIGEST)
      return { status: 'denied', code: 'confirm-mismatch', text: 'wrong confirmation' }
    return run()
  }
}

function remoteOf(answers: Record<string, (r: OpsRunRequest) => Promise<OpsRunResult>>) {
  const sent: { hostId: string; request: OpsRunRequest }[] = []
  return {
    sent,
    remote: {
      run: async (hostId: string, request: OpsRunRequest): Promise<OpsRunResult> => {
        sent.push({ hostId, request })
        const answer = answers[hostId]
        if (!answer) return { status: 'denied', code: 'unavailable', text: 'unavailable (offline)' }
        return answer(request)
      },
    },
  }
}

const purge = (hosts: readonly string[] | 'all') => ({
  op: 'archive.purge',
  args: { all: true },
  hosts,
})

describe('--host asks: one origin confirmation over every target', () => {
  it('asks on this machine for a single target, carrying the target’s own confirm', async () => {
    const r = remoteOf({ [BEE1]: asking(1, ['lane-a', 'lane-b']) })
    const h = createHarness({ remote: r.remote, hosts: resolver })
    const reply = await h.tool(purge([BEE1]))
    expect(reply.status).toBe('confirm')
    if (reply.status !== 'confirm') return
    expect(reply.confirmId).not.toBe(targetConfirm(1))
    expect(h.calls.created).toHaveLength(1)
    expect(h.calls.created[0]).toMatchObject({
      sessionId: 's1',
      items: [
        {
          hostId: BEE1,
          machineLabel: 'bee1',
          op: 'archive.purge',
          ids: ['lane-a', 'lane-b'],
          labels: ['lane-a', 'lane-b'],
          confirmId: targetConfirm(1),
          digest: DIGEST,
        },
      ],
    })
    h.approve(reply.confirmId)
    const done = await h.tool(purge([BEE1]), {
      confirm: { confirmId: reply.confirmId, digest: reply.digest },
    })
    expect(done).toMatchObject({ status: 'ok', text: 'purged' })
    expect(r.sent.map((s) => s.request.confirm)).toEqual([
      undefined,
      { confirmId: targetConfirm(1), digest: DIGEST },
    ])
  })

  it('lists every asking machine’s exact ids in one confirmation and reports per machine', async () => {
    const r = remoteOf({
      [BEE1]: asking(1, ['a1']),
      [BEE2]: async () => ok('nothing to purge'),
      [BEE3]: asking(3, ['c1', 'c2']),
    })
    const h = createHarness({ remote: r.remote, hosts: resolver })
    const reply = await h.tool(purge([BEE1, BEE2, BEE3]))
    if (reply.status !== 'confirm') throw new Error(`expected confirm, got ${reply.status}`)
    expect(h.calls.created[0]?.items).toMatchObject([
      { hostId: BEE1, machineLabel: 'bee1', ids: ['a1'], confirmId: targetConfirm(1) },
      { hostId: BEE3, machineLabel: 'bee3', ids: ['c1', 'c2'], confirmId: targetConfirm(3) },
    ])
    const first = r.sent.map((s) => s.request.batch)
    expect(new Set(first.map((b) => b?.id)).size).toBe(1)
    expect(first.map((b) => [b?.index, b?.size])).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
    ])
    h.approve(reply.confirmId)
    const done = await h.tool(purge([BEE1, BEE2, BEE3]), {
      confirm: { confirmId: reply.confirmId, digest: reply.digest },
    })
    expect(done).toMatchObject({
      status: 'ok',
      text: '== bee1 (ok)\npurged\n== bee2 (ok)\nnothing to purge\n== bee3 (ok)\npurged',
    })
    // The machine that already answered is never contacted again.
    expect(r.sent.slice(3).map((s) => s.hostId)).toEqual([BEE1, BEE3])
  })

  it('denies a target that was not approved there: an older app answered the dialog', async () => {
    const r = remoteOf({
      [BEE1]: asking(1, ['a1']),
      [BEE2]: asking(2, ['b1'], () => ({
        status: 'denied',
        code: 'confirm-denied',
        text: 'The user has not approved this yet. Ask again after they answer.',
      })),
    })
    const h = createHarness({ remote: r.remote, hosts: resolver })
    const reply = await h.tool(purge([BEE1, BEE2]))
    if (reply.status !== 'confirm') throw new Error('expected confirm')
    h.approve(reply.confirmId)
    const done = await h.tool(purge([BEE1, BEE2]), {
      confirm: { confirmId: reply.confirmId, digest: reply.digest },
    })
    expect(done).toMatchObject({
      status: 'ok',
      text: '1 of 2 hosts failed\n== bee1 (ok)\npurged\n== bee2 (denied)\nNot approved on bee2. Approve from an updated Phosphor app.',
      data: {
        hosts: [
          { hostId: BEE1, status: 'ok' },
          { hostId: BEE2, status: 'denied', code: 'confirm-denied' },
        ],
      },
    })
  })

  it('never resends a write: an unanswered target is reported, not retried', async () => {
    const r = remoteOf({
      [BEE1]: asking(1, ['a1']),
      [BEE3]: asking(3, ['c1'], () => ({
        status: 'denied',
        code: 'unavailable',
        text: 'bee3 did not confirm the change. Check it before you try again.',
      })),
    })
    const h = createHarness({ remote: r.remote, hosts: resolver })
    const reply = await h.tool(purge([BEE1, BEE2, BEE3]))
    if (reply.status !== 'confirm') throw new Error('expected confirm')
    h.approve(reply.confirmId)
    const ref = { confirmId: reply.confirmId, digest: reply.digest }
    const done = await h.tool(purge([BEE1, BEE2, BEE3]), { confirm: ref })
    expect(done).toMatchObject({ status: 'ok' })
    expect(r.sent.map((s) => s.hostId)).toEqual([BEE1, BEE2, BEE3, BEE1, BEE3])
    // The origin confirmation is single use: a second resubmission sends nothing.
    expect(await h.tool(purge([BEE1, BEE2, BEE3]), { confirm: ref })).toMatchObject({
      status: 'denied',
    })
    expect(r.sent).toHaveLength(5)
  })

  it('waits for the user, and answers expired once the batch outlives the confirm TTL', async () => {
    const r = remoteOf({ [BEE1]: asking(1, ['a1']) })
    const h = createHarness({ remote: r.remote, hosts: resolver })
    const reply = await h.tool(purge([BEE1]))
    if (reply.status !== 'confirm') throw new Error('expected confirm')
    const ref = { confirmId: reply.confirmId, digest: reply.digest }
    expect(await h.tool(purge([BEE1]), { confirm: ref })).toMatchObject({
      code: 'confirm-denied',
    })
    h.approve(reply.confirmId)
    h.clock.now += 600_001
    expect(await h.tool(purge([BEE1]), { confirm: ref })).toMatchObject({
      status: 'denied',
      code: 'confirm-expired',
    })
    expect(r.sent).toHaveLength(1)
  })

  it('refuses an unattended run instead of asking anyone', async () => {
    const r = remoteOf({ [BEE1]: asking(1, ['a1']) })
    const h = createHarness({
      remote: r.remote,
      hosts: resolver,
      agents: {
        s1: {
          kind: 'agent',
          laneRef: 'local/session:s1',
          sessionId: 's1',
          unattended: true,
          lineage: 0,
        },
      },
    })
    expect(await h.tool(purge([BEE1]))).toMatchObject({ status: 'denied', code: 'unattended' })
    expect(h.calls.created).toEqual([])
  })

  it('binds a real confirmation a surface can read and relay, machine by machine', async () => {
    const store = createConfirmStore()
    const r = remoteOf({ [BEE1]: asking(1, ['a1']), [BEE3]: asking(3, ['c1']) })
    const h = createHarness({
      remote: r.remote,
      hosts: resolver,
      confirms: confirmPort(store, () => undefined),
    })
    const reply = await h.tool(purge([BEE1, BEE3]))
    if (reply.status !== 'confirm') throw new Error(`expected confirm: ${JSON.stringify(reply)}`)
    const info = store.info(surface(), { confirmId: reply.confirmId })
    if (!info.ok) throw new Error('expected info')
    expect(info.info.items).toEqual([
      {
        hostId: BEE1,
        op: 'archive.purge',
        ids: ['a1'],
        labels: ['a1'],
        confirmId: targetConfirm(1),
        digest: DIGEST,
      },
      {
        hostId: BEE3,
        op: 'archive.purge',
        ids: ['c1'],
        labels: ['c1'],
        confirmId: targetConfirm(3),
        digest: DIGEST,
      },
    ])
    expect(reply.message).toContain('On bee1:\n• a1')
    expect(reply.message).toContain('On bee3:\n• c1')
  })
})

describe('--host naming this machine', () => {
  it('runs the op here and reaches no other machine', async () => {
    const r = remoteOf({})
    const h = createHarness({
      remote: r.remote,
      hosts: { resolve: async () => ({ ok: true, self: true }) },
    })
    expect(await h.tool({ op: 'artifact.list', hosts: ['this-mac'] })).toMatchObject({
      status: 'ok',
      text: 'artifact.list done',
    })
    expect(h.calls.handled.map((c) => c.op)).toEqual(['artifact.list'])
    expect(r.sent).toEqual([])
  })
})

describe('createRouteBatches', () => {
  const batch = (expiresAt: number, creator = 'agent:a') => ({
    creator,
    expiresAt,
    targets: [{ host: { id: BEE1, label: 'bee1' }, first: ok('x') }],
  })

  it('keeps a batch until its confirm expires, then forgets it', () => {
    const clock = { now: 0 }
    const batches = createRouteBatches(() => clock.now)
    batches.remember('c1', batch(600_000))
    clock.now = 599_999
    expect(batches.has('c1')).toBe(true)
    clock.now = 600_000
    expect(batches.has('c1')).toBe(false)
    expect(batches.take('c1', 'agent:a')).toBeNull()
  })

  it('hands a batch only to its creator, once, and drops it on request', () => {
    const batches = createRouteBatches(() => 0)
    batches.remember('c1', batch(10))
    batches.remember('c2', batch(10))
    expect(batches.take('c1', 'agent:b')).toBeNull()
    expect(batches.take('c1', 'agent:a')).toMatchObject({ creator: 'agent:a' })
    expect(batches.take('c1', 'agent:a')).toBeNull()
    batches.drop('c2')
    expect(batches.size()).toBe(0)
  })

  it('holds at most its limit, dropping the oldest first', () => {
    expect(ROUTE_BATCH_LIMITS.entries).toBe(CONFIRM_STORE_LIMITS.records)
    const batches = createRouteBatches(() => 0, 2)
    for (const id of ['c1', 'c2', 'c3']) batches.remember(id, batch(10))
    expect(batches.size()).toBe(2)
    expect([batches.has('c1'), batches.has('c2'), batches.has('c3')]).toEqual([false, true, true])
  })
})
