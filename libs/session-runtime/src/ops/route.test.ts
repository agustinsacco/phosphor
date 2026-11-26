import { describe, expect, it, vi } from 'vitest'
import {
  OPS_LIMITS,
  parseOpsRunResult,
  type OpsRunRequest,
  type OpsRunResult,
} from '@phosphor/shared/host-protocol-ops'
import { OP_CATALOG } from '@phosphor/shared/ops-catalog'
import { parseOpArgv } from '@phosphor/shared/ops-cli'
import { createOpsDispatcher } from './dispatcher'
import { createHarness, DIGEST, OWN, type HarnessOptions } from './__fixtures__/dispatcher-harness'
import { clipBytes } from './route-result'

const ok = (text: string): OpsRunResult => ({ status: 'ok', text, applies: 'now' })

function remoteOf(answers: Record<string, (r: OpsRunRequest) => Promise<OpsRunResult>>) {
  const sent: { hostId: string; request: OpsRunRequest }[] = []
  return {
    sent,
    remote: {
      run: async (hostId: string, request: OpsRunRequest) => {
        sent.push({ hostId, request })
        const answer = answers[hostId]
        if (!answer) throw new Error('offline')
        return answer(request)
      },
    },
  }
}

const harness = (remote: HarnessOptions['remote'], options: HarnessOptions = {}) =>
  createHarness({ remote, ...options })

const list = { op: 'artifact.list', args: {} }

describe('--host refusals on this machine', () => {
  it('refuses before any network call', async () => {
    const r = remoteOf({ bee1: async () => ok('x') })
    const h = harness(r.remote)
    const credentials = { op: 'config.write', args: { file: 'models', content: '{}' } }
    expect(await h.tool({ ...credentials, hosts: ['bee1'] })).toMatchObject({ code: 'never' })
    expect(await h.tool({ op: 'swarm.on', hosts: ['bee1'] })).toMatchObject({
      code: 'bad-request',
      text: 'swarm.on cannot run on another machine.',
    })
    h.setPolicy({ agentControl: 'read' })
    const settings = { op: 'settings.set', args: { key: 'contextBudget', value: 1 } }
    expect(await h.tool({ ...settings, hosts: ['bee1'] })).toMatchObject({ code: 'policy' })
    h.setPolicy({ machineOps: 'off' })
    expect(await h.tool({ ...list, hosts: ['bee1'] })).toMatchObject({
      code: 'policy',
      text: 'Reaching other machines is off on this machine.',
    })
    h.setPolicy({ machineOps: 'read' })
    expect(await h.tool({ ...settings, hosts: ['bee1'] })).toMatchObject({
      text: 'Reaching other machines is read-only on this machine.',
    })
    expect(await h.tool({ ...settings, hosts: ['bee1'] }, { reason: undefined })).toMatchObject({
      code: 'policy',
    })
    expect(r.sent).toEqual([])
  })

  it('needs a remote port, and a reason above read', async () => {
    const h = createHarness()
    expect(await h.tool({ ...list, hosts: ['bee1'] })).toMatchObject({ code: 'unsupported' })
    const r = remoteOf({})
    const settings = { op: 'settings.set', args: { key: 'contextBudget', value: 1 } }
    expect(
      await harness(r.remote).tool({ ...settings, hosts: ['bee1'] }, { reason: undefined }),
    ).toMatchObject({ text: 'Add a short reason.' })
    expect(r.sent).toEqual([])
  })
})

describe('--host fan-out', () => {
  it('returns one host’s answer unchanged and forwards attribution only', async () => {
    const r = remoteOf({ bee1: async () => ok('2 artifacts') })
    const h = harness(r.remote)
    const reply = await h.tool({ ...list, hosts: ['bee1'] }, { reason: 'looking' })
    expect(reply).toMatchObject({ status: 'ok', text: '2 artifacts' })
    expect(r.sent).toEqual([
      {
        hostId: 'bee1',
        request: {
          op: 'artifact.list',
          args: {},
          actor: { kind: 'agent', lane: OWN, title: 'Mine' },
          reason: 'looking',
        },
      },
    ])
    expect(h.calls.audit.at(-1)).toMatchObject({ op: 'artifact.list', scope: 'machine' })
  })

  it('never forwards the caller’s confirm: a target only sees its own', async () => {
    const r = remoteOf({ bee1: async () => ok('x') })
    const confirm = { confirmId: '22222222-2222-4222-8222-222222222222', digest: DIGEST }
    const reply = await harness(r.remote).tool(
      { op: 'archive.purge', args: { all: true }, hosts: ['bee1'] },
      { confirm },
    )
    expect(reply).toMatchObject({ status: 'denied', code: 'confirm-mismatch' })
    expect(r.sent).toEqual([])
  })

  it('keeps the caller’s order and survives a host that fails', async () => {
    const r = remoteOf({
      bee1: () => new Promise((resolve) => setTimeout(() => resolve(ok('3 artifacts')), 20)),
      bee3: async () => ({ status: 'denied', code: 'unsupported', text: 'Update that Host.' }),
    })
    const reply = await harness(r.remote).tool({ ...list, hosts: ['bee1', 'bee2', 'bee3'] })
    expect(reply).toMatchObject({
      status: 'ok',
      text: '2 of 3 hosts failed\n== bee1 (ok)\n3 artifacts\n== bee2 (denied)\nCould not reach bee2.\n== bee3 (denied)\nUpdate that Host.',
      data: {
        summary: { total: 3, ok: 1, failed: 2 },
        hosts: [
          { hostId: 'bee1', label: 'bee1', status: 'ok' },
          { hostId: 'bee2', label: 'bee2', status: 'denied', code: 'unavailable' },
          { hostId: 'bee3', label: 'bee3', status: 'denied', code: 'unsupported' },
        ],
      },
    })
    expect(r.sent.every((s) => s.request.confirm === undefined)).toBe(true)
  })

  it('denies an all-failed batch using the first code and preserves each failure', async () => {
    const r = remoteOf({
      a: async () => ({ status: 'denied', code: 'unsupported', text: 'Update.' }),
      b: async () => ({ status: 'denied', code: 'policy', text: 'Read-only.' }),
    })
    expect(await harness(r.remote).tool({ ...list, hosts: ['a', 'b'] })).toMatchObject({
      status: 'denied',
      code: 'unsupported',
      text: '== a (denied)\nUpdate.\n== b (denied)\nRead-only.',
      data: {
        summary: { total: 2, ok: 0, failed: 2 },
        hosts: [
          { hostId: 'a', code: 'unsupported', text: 'Update.' },
          { hostId: 'b', code: 'policy', text: 'Read-only.' },
        ],
      },
    })
  })

  it('keeps raw per-host cursors and continues on the selected host only', async () => {
    const a = '20'
    const b = 'h1_000000000000000000000000_30'
    const r = remoteOf({
      idA: async () => ({ ...ok('first'), data: { rows: [1] }, next: a }),
      idB: async () => ({ ...ok('second'), data: { rows: [2] }, next: b }),
    })
    const h = harness(r.remote, {
      hosts: {
        resolve: async (hosts) => ({
          ok: true,
          hosts: (hosts === 'all' ? ['a', 'b'] : hosts).map((label) => ({
            id: label === 'a' ? 'idA' : 'idB',
            label,
          })),
        }),
      },
    })
    const result = await h.tool({ ...list, hosts: ['a', 'b'] })
    expect(result).toMatchObject({
      status: 'ok',
      text: expect.stringContaining(`--host "b" --page "${b}"`),
      data: {
        hosts: [
          { hostId: 'idA', label: 'a', data: { rows: [1] }, next: a },
          { hostId: 'idB', label: 'b', data: { rows: [2] }, next: b },
        ],
      },
    })
    expect(result).not.toHaveProperty('next')
    for (const hosts of [['a', 'b'], 'all'] as const) {
      expect(await h.tool({ ...list, ...{ page: a }, hosts })).toMatchObject({
        code: 'bad-request',
        text: expect.stringContaining('one host'),
      })
    }
    expect(r.sent).toHaveLength(2)
    await h.tool({ ...list, ...{ page: b }, hosts: ['b'] })
    expect(r.sent[2]).toMatchObject({ hostId: 'idB', request: { page: b } })
  })

  it('omits only the oversized host data and keeps its continuation', async () => {
    const r = remoteOf({
      a: async () => ({
        ...ok('large'),
        next: '20',
        data: 'x'.repeat(OPS_LIMITS.callDataBytes / 2),
      }),
      b: async () => ({
        status: 'denied',
        code: 'policy',
        text: 'refused',
        data: { detail: 'read only' },
      }),
    })
    const out = await harness(r.remote).tool({ ...list, hosts: ['a', 'b'] })
    expect(parseOpsRunResult(out)).toMatchObject({
      data: {
        hosts: [
          {
            status: 'ok',
            text: 'large',
            next: '20',
            data: { omitted: true, reason: expect.stringContaining('--host "a"') },
          },
          { status: 'denied', code: 'policy', text: 'refused', data: { detail: 'read only' } },
        ],
      },
    })
  })

  it('routes a qualified ref and refuses conflicting or ambiguous host selections before sends', async () => {
    const r = remoteOf({ bee2: async () => ok('lane') })
    const h = harness(r.remote)
    const lane = { op: 'lane.read', args: { ref: 'host:bee2/lane:x' } }
    expect(await h.tool(lane)).toMatchObject({ status: 'ok', text: 'lane' })
    expect(await h.tool({ ...lane, hosts: ['other'] })).toMatchObject({
      code: 'bad-request',
      text: expect.stringContaining('conflicts'),
    })
    expect(await h.tool({ ...lane, args: { ref: 'x' }, hosts: ['bee2', 'other'] })).toMatchObject({
      code: 'bad-request',
    })
    expect(r.sent).toMatchObject([{ hostId: 'bee2', request: lane }])
  })

  it('passes one catalog deadline and does not dispatch the second wave after it expires', async () => {
    vi.useFakeTimers()
    try {
      const deadlines: number[] = []
      const signals: AbortSignal[] = []
      const h = harness({
        run: async (_id, _request, options) => {
          deadlines.push(options.deadlineAt)
          signals.push(options.signal)
          await new Promise((resolve) => setTimeout(resolve, 40))
          return ok('late')
        },
      })
      const dispatcher = createOpsDispatcher(h.binding, {
        ...h.deps,
        catalog: OP_CATALOG.map((spec) =>
          spec.name === list.op ? { ...spec, deadlineMs: 20 } : spec,
        ),
        parseArgv: (argv) => parseOpArgv(argv),
      })
      const pending = dispatcher.runFromTool('s1', {
        v: 1,
        id: 'routed-deadline',
        argv: ['artifact', 'list', '--host', 'a,b,c,d,e'],
        deadlineMs: 600_000,
      })
      await vi.advanceTimersByTimeAsync(50)
      expect(await pending).toMatchObject({
        op: 'artifact.list',
        code: 'timeout',
        text: expect.stringContaining('execution after 0.02 seconds'),
      })
      expect(deadlines).toEqual(Array(4).fill(h.clock.now + 20))
      expect(new Set(signals).size).toBe(1)
      expect(signals[0]?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('warns that a remote write may be unconfirmed at the tool deadline', async () => {
    vi.useFakeTimers()
    try {
      const h = harness({
        async run(_id, _request, budget) {
          budget.onRemoteWrite?.()
          await new Promise((resolve) => setTimeout(resolve, 40))
          return ok('late')
        },
      })
      const result = h.tool(
        { op: 'settings.set', args: { key: 'contextBudget', value: 1 }, hosts: ['bee2'] },
        { deadlineMs: 20 },
      )
      await vi.advanceTimersByTimeAsync(50)
      expect(await result).toMatchObject({
        code: 'timeout',
        text: expect.stringContaining('unconfirmed'),
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('reaches at most four hosts at once', async () => {
    let running = 0
    let peak = 0
    const slow = async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, 5))
      running--
      return ok('ok')
    }
    const ids = Array.from({ length: 9 }, (_, i) => `h${i}`)
    const r = remoteOf(Object.fromEntries(ids.map((id) => [id, slow])))
    expect((await harness(r.remote).tool({ ...list, hosts: ids })).status).toBe('ok')
    expect(peak).toBe(OPS_LIMITS.batchConcurrency)
  })

  it('cuts each host’s share so the merged text fits the result limit', async () => {
    const big = 'x'.repeat(OPS_LIMITS.resultBytes)
    const r = remoteOf({ a: async () => ok(big), b: async () => ok(big) })
    const reply = await harness(r.remote).tool({ ...list, hosts: ['a', 'b'] })
    if (reply.status !== 'ok') throw new Error('expected ok')
    expect(Buffer.byteLength(reply.text)).toBeLessThanOrEqual(OPS_LIMITS.resultBytes)
    expect(
      reply.text
        .split('\n')
        .filter((l) => l.endsWith('[…cut]'))
        .map(() => true),
    ).toEqual([true, true])
  })

  it('resolves names and all through the resolver, in directory order', async () => {
    const r = remoteOf({ id2: async () => ok('two'), id1: async () => ok('one') })
    const h = harness(r.remote, {
      hosts: {
        resolve: async (hosts) =>
          hosts === 'all'
            ? {
                ok: true,
                hosts: [
                  { id: 'id2', label: 'bee2' },
                  { id: 'id1', label: 'bee1' },
                ],
              }
            : { ok: false, text: `Several machines match ${hosts.join(',')}: bee1, bee2.` },
      },
    })
    expect(await h.tool({ ...list, hosts: 'all' })).toMatchObject({
      text: '== bee2 (ok)\ntwo\n== bee1 (ok)\none',
    })
    expect(await h.tool({ ...list, hosts: ['bee'] })).toMatchObject({
      code: 'bad-request',
      text: 'Several machines match bee: bee1, bee2.',
    })
  })

  it('refuses all without a resolver and more than 20 hosts', async () => {
    const r = remoteOf({})
    const h = harness(r.remote)
    expect(await h.tool({ ...list, hosts: 'all' })).toMatchObject({ code: 'bad-request' })
    const many = Array.from({ length: OPS_LIMITS.hostsPerBatch + 1 }, (_, i) => `h${i}`)
    expect(await h.tool({ ...list, hosts: many })).toMatchObject({ code: 'bad-request' })
    expect(r.sent).toEqual([])
  })
})

describe('clipBytes', () => {
  it('cuts on a UTF-8 boundary and says so', () => {
    expect(clipBytes('short', 10)).toBe('short')
    const cut = clipBytes('é'.repeat(20), 15)
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(15)
    expect(cut).toMatch(/^é+ \[…cut\]$/)
  })
})
