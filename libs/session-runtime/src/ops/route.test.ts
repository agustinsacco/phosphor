import { describe, expect, it } from 'vitest'
import {
  OPS_LIMITS,
  type OpsRunRequest,
  type OpsRunResult,
} from '@phosphor/shared/host-protocol-ops'
import { createHarness, DIGEST, OWN, type HarnessOptions } from './__fixtures__/dispatcher-harness'
import { clipBytes } from './route'

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
    const asked: OpsRunResult = {
      status: 'confirm',
      confirmId: '11111111-1111-4111-8111-111111111111',
      digest: DIGEST,
      title: 'Phosphor: archive.purge',
      message: 'm',
      items: [{ hostId: null, op: 'archive.purge', ids: ['a'], labels: ['a'] }],
      expiresAt: 5,
    }
    const r = remoteOf({ bee1: async () => asked })
    const h = harness(r.remote)
    const confirm = { confirmId: '22222222-2222-4222-8222-222222222222', digest: DIGEST }
    const reply = await h.tool(
      { op: 'archive.purge', args: { all: true }, hosts: ['bee1'] },
      { confirm },
    )
    expect(reply).toMatchObject({ status: 'confirm', confirmId: asked.confirmId })
    expect(r.sent).toEqual([
      {
        hostId: 'bee1',
        request: {
          op: 'archive.purge',
          args: { all: true },
          actor: { kind: 'agent', lane: OWN, title: 'Mine' },
          reason: 'testing',
          confirm,
        },
      },
    ])
    expect(h.calls.audit.at(-1)).toMatchObject({ op: 'archive.purge', scope: 'machine' })
  })

  it('keeps the caller’s order and survives a host that fails', async () => {
    const r = remoteOf({
      bee1: () => new Promise((resolve) => setTimeout(() => resolve(ok('3 artifacts')), 20)),
      bee3: async () => ({ status: 'denied', code: 'unsupported', text: 'Update that Host.' }),
    })
    const reply = await harness(r.remote).tool({ ...list, hosts: ['bee1', 'bee2', 'bee3'] })
    expect(reply).toMatchObject({
      status: 'ok',
      text: 'bee1: 3 artifacts\nbee2: unavailable (offline)\nbee3: unsupported: Update that Host.',
      data: {
        hosts: [
          { hostId: 'bee1', label: 'bee1', status: 'ok' },
          { hostId: 'bee2', label: 'bee2', status: 'denied', code: 'unavailable' },
          { hostId: 'bee3', label: 'bee3', status: 'denied', code: 'unsupported' },
        ],
      },
    })
    expect(r.sent.every((s) => s.request.confirm === undefined)).toBe(true)
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
    expect(reply.text.split('\n').map((l) => l.endsWith('[…cut]'))).toEqual([true, true])
  })

  it('lists each asking target’s own confirmation by host', async () => {
    const confirmOf = (id: string): OpsRunResult => ({
      status: 'confirm',
      confirmId: id,
      digest: DIGEST,
      title: 'Phosphor: archive.purge',
      message: 'm',
      items: [{ hostId: null, op: 'archive.purge', ids: ['x'], labels: ['x'] }],
      expiresAt: id.startsWith('1') ? 9 : 7,
    })
    const one = '11111111-1111-4111-8111-111111111111'
    const two = '33333333-3333-4333-8333-333333333333'
    const r = remoteOf({
      a: async () => confirmOf(one),
      b: async () => ok('nothing to purge'),
      c: async () => confirmOf(two),
    })
    const reply = await harness(r.remote).tool({
      op: 'archive.purge',
      args: { all: true },
      hosts: ['a', 'b', 'c'],
    })
    expect(reply).toMatchObject({ status: 'confirm', confirmId: one, timeoutMs: 1000 })
    expect(r.sent.map((s) => s.hostId)).toEqual(['a', 'b', 'c'])
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
    expect(await h.tool({ ...list, hosts: 'all' })).toMatchObject({ text: 'bee2: two\nbee1: one' })
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
