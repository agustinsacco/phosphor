import { describe, expect, it } from 'vitest'
import { AGENT_POLICY_DEFAULT, type AgentPolicy, type OpTier } from '@phosphor/shared/ops'
import type { OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import {
  agent,
  createHarness,
  DIGEST,
  local,
  machine,
  OTHER,
  OWN,
  surface,
} from './__fixtures__/dispatcher-harness'
import type { OpPrincipal } from './types'

const TIER_OPS: Record<OpTier, { op: string; args: Record<string, unknown> }> = {
  read: { op: 'archive.list', args: {} },
  lane: { op: 'notify', args: { text: 'hi' } },
  create: { op: 'archive.restore', args: { id: 'a1' } },
  configure: { op: 'settings.set', args: { key: 'contextBudget', value: 100_000 } },
  persistence: { op: 'routine.enable', args: { id: 'r1' } },
  destructive: { op: 'archive.purge', args: { ids: ['a1'] } },
  never: { op: 'brain.reset', args: {} },
}
const LEVELS = ['all', 'read', 'off'] as const
const PRINCIPALS: Record<OpPrincipal['kind'], () => OpPrincipal> = {
  surface: () => surface(),
  agent: () => agent(),
  machine,
  local,
}

const outcome = (r: OpsRunResult) => (r.status === 'denied' ? `denied:${r.code}` : r.status)

function expected(
  kind: OpPrincipal['kind'],
  policy: Pick<AgentPolicy, 'agentControl' | 'machineOps'>,
  tier: OpTier,
): string {
  if (kind === 'surface') return 'ok'
  const level = kind === 'machine' ? policy.machineOps : policy.agentControl
  if (level === 'off' || (level === 'read' && tier !== 'read')) return 'denied:policy'
  if (tier === 'never') return 'denied:never'
  return tier === 'destructive' ? 'confirm' : 'ok'
}

describe('policy matrix: tier × scope × principal × agentControl × machineOps', () => {
  const cases = Object.keys(PRINCIPALS).flatMap((kind) =>
    LEVELS.flatMap((agentControl) =>
      LEVELS.flatMap((machineOps) =>
        (Object.keys(TIER_OPS) as OpTier[]).map((tier) => ({
          kind: kind as OpPrincipal['kind'],
          agentControl,
          machineOps,
          tier,
        })),
      ),
    ),
  )
  it.each(cases)('$kind, agentControl $agentControl, machineOps $machineOps, $tier', async (c) => {
    const policy = { agentControl: c.agentControl, machineOps: c.machineOps }
    const h = createHarness({ policy })
    const { op, args } = TIER_OPS[c.tier]
    const result = await h.run(PRINCIPALS[c.kind](), { op, args, reason: 'tidy up' })
    expect(outcome(result)).toBe(expected(c.kind, policy, c.tier))
  })

  it('asks for another lane’s stop but runs the agent’s own stop as a lane op', async () => {
    const h = createHarness()
    expect((await h.tool({ op: 'lane.stop', args: { ref: OTHER } })).status).toBe('confirm')
    expect((await h.tool({ op: 'lane.stop', args: { ref: OWN } })).status).toBe('ok')
    expect(h.calls.audit.at(-1)).toMatchObject({ op: 'lane.stop', tier: 'lane', scope: 'self' })
  })

  it('lets an op entry relax a destructive op, but never another lane’s ask', async () => {
    const h = createHarness({
      policy: { ops: { 'archive.purge': 'allow', 'lane.delete': 'allow' } },
    })
    const reason = 'cleanup'
    expect(
      (await h.run(agent(), { op: 'archive.purge', args: { ids: ['a1'] }, reason })).status,
    ).toBe('ok')
    expect((await h.run(agent(), { op: 'lane.delete', args: { ref: OTHER }, reason })).status).toBe(
      'confirm',
    )
  })

  it('runs Brain service ops with the kill switch off', async () => {
    const h = createHarness({ policy: { agentControl: 'off' } })
    expect((await h.tool({ op: 'brain.search', args: { query: 'x' } })).status).toBe('ok')
    expect((await h.tool({ op: 'swarm.off' })).status).toBe('denied')
  })
})

describe('principals', () => {
  it.each([agent(), machine(), local()])('refuses surface-only ops for $kind', async (p) => {
    const h = createHarness()
    const list = await h.run(p, { op: 'confirm.list', args: {} })
    expect(list).toMatchObject({ status: 'denied', code: 'forbidden' })
    const set = await h.run(p, {
      op: 'policy.set',
      args: { policy: AGENT_POLICY_DEFAULT },
      reason: 'x',
    })
    expect(set).toMatchObject({ status: 'denied', code: 'never' })
    expect(h.calls.handled).toEqual([])
  })

  it('serves surface-only ops to a surface', async () => {
    const h = createHarness()
    expect((await h.run(surface(), { op: 'confirm.list', args: {} })).status).toBe('ok')
  })

  it('judges a machine principal by machineOps whatever actor says', async () => {
    const h = createHarness({ policy: { agentControl: 'all', machineOps: 'read' } })
    const result = await h.run(machine(), {
      op: 'settings.set',
      args: { key: 'contextBudget', value: 100_000 },
      reason: 'x',
      actor: { kind: 'agent', lane: 'host:a/lane:b' },
    })
    expect(result).toMatchObject({ status: 'denied', code: 'policy' })
    expect(h.calls.audit.at(-1)).toMatchObject({ principal: 'machine:m-stark' })
  })

  it('lets actor only downgrade: a surface with an actor is judged as an agent', async () => {
    const h = createHarness({ policy: { agentControl: 'off' } })
    const args = { key: 'contextBudget', value: 100_000 }
    expect((await h.run(surface(), { op: 'settings.set', args })).status).toBe('ok')
    const asAgent = await h.run(surface(), {
      op: 'settings.set',
      args,
      reason: 'x',
      actor: { kind: 'agent', lane: OWN },
    })
    expect(asAgent).toMatchObject({ status: 'denied', code: 'policy' })
    h.setPolicy({})
    const purge = { op: 'archive.purge', args: { ids: ['a'] }, reason: 'x' }
    expect((await h.run(surface(), purge)).status).toBe('ok')
    expect((await h.run(surface(), { ...purge, actor: { kind: 'agent' } })).status).toBe('confirm')
  })

  it('never lifts an agent with an actor to a surface', async () => {
    const h = createHarness()
    const result = await h.run(agent(), {
      op: 'confirm.list',
      args: {},
      actor: { kind: 'agent', lane: OWN },
    })
    expect(result).toMatchObject({ status: 'denied', code: 'forbidden' })
  })

  it('refuses a surface connection that lacks the op’s capabilities', async () => {
    const h = createHarness({
      surfaceAdmits: (_p, requires) => !requires.caps?.includes('routines'),
    })
    expect(await h.run(surface(), { op: 'routine.enable', args: { id: 'r' } })).toMatchObject({
      status: 'denied',
      code: 'forbidden',
    })
  })
})

describe('limits', () => {
  const create = { op: 'lane.create', args: { folder: '/tmp/ws' }, reason: 'new task' }

  it('refuses create ops from a lane two agent levels deep', async () => {
    const h = createHarness({ createdBy: { 'local/session:deep': 2 } })
    expect((await h.run(agent({ lineage: 1 }), create)).status).toBe('ok')
    expect(await h.run(agent({ lineage: 2 }), create)).toMatchObject({ code: 'limit' })
    const recorded = agent({ laneRef: 'local/session:deep', sessionId: 'sd' })
    expect(await h.run(recorded, create)).toMatchObject({ code: 'limit' })
    expect(h.calls.audit.at(-1)).toMatchObject({ decision: 'denied-limit' })
  })

  it('allows 10 agent-created lanes per 10 minutes across the machine', async () => {
    const h = createHarness()
    for (let i = 0; i < 10; i++)
      expect((await h.run(agent({ laneRef: `l${i}`, sessionId: `s${i}` }), create)).status).toBe(
        'ok',
      )
    expect(await h.run(machine(), create)).toMatchObject({ code: 'limit' })
    expect((await h.run(surface(), { ...create, reason: undefined })).status).toBe('ok')
    h.clock.now += 10 * 60_000
    expect((await h.run(machine(), create)).status).toBe('ok')
  })

  it('allows 120 ops a minute per principal', async () => {
    const h = createHarness()
    const read = { op: 'archive.list', args: {} }
    for (let i = 0; i < 120; i++) expect((await h.run(agent(), read)).status).toBe('ok')
    expect(await h.run(agent(), read)).toMatchObject({ status: 'denied', code: 'limit' })
    expect((await h.run(local(), read)).status).toBe('ok')
    h.clock.now += 60_000
    expect((await h.run(agent(), read)).status).toBe('ok')
  })
})

describe('refusals before any confirmation lookup', () => {
  const confirm = { confirmId: '00000000-0000-4000-8000-000000000000', digest: DIGEST }

  it('never consults the confirm store for never, kill switch or user-off', async () => {
    const h = createHarness()
    await h.tool({ op: 'brain.reset' }, { confirm })
    await h.tool({ op: 'swarm.on' }, { confirm, facts: { swarm: swarmOff } })
    h.setPolicy({ agentControl: 'off' })
    await h.tool({ op: 'lane.delete', args: { ref: OTHER } }, { confirm })
    expect(h.calls.consumed).toEqual([])
  })

  it('refuses swarm.on and a context file the user turned off', async () => {
    const h = createHarness()
    const swarm = await h.tool({ op: 'swarm.on' }, { facts: { swarm: swarmOff } })
    expect(swarm).toMatchObject({ status: 'denied', code: 'user-off' })
    const files = await h.tool(
      { op: 'contextFiles.set', args: { agents: true } },
      { facts: { contextFiles: { off: ['agents'], userOff: ['agents'] } } },
    )
    expect(files).toMatchObject({ status: 'denied', code: 'user-off' })
    expect(h.calls.audit.map((r) => r.decision)).toEqual(['denied-user-off', 'denied-user-off'])
  })

  it('answers unattended for an asked op in a routine run, and asks nothing', async () => {
    const h = createHarness({ agents: { s1: agent({ unattended: true }) } })
    const reply = await h.tool({ op: 'lane.delete', args: { ref: OTHER } })
    expect(reply).toMatchObject({ status: 'denied', code: 'unattended' })
    expect(h.calls.created).toEqual([])
    expect(h.calls.audit.at(-1)).toMatchObject({ decision: 'denied-unattended' })
  })

  it('requires a reason from agents above read, not from the command line', async () => {
    const h = createHarness()
    const args = { key: 'contextBudget', value: 100_000 }
    expect(await h.run(agent(), { op: 'settings.set', args })).toMatchObject({
      code: 'bad-request',
      text: 'Add a short reason.',
    })
    expect((await h.run(local(), { op: 'settings.set', args })).status).toBe('ok')
  })
})

const swarmOff = {
  available: true,
  requested: false,
  enabled: false,
  lastBy: 'user' as const,
  userOff: true,
}

describe('other lanes', () => {
  const controlled = (clientId: string | null, busy = false) =>
    createHarness({
      lanes: [
        { ref: OWN, sessionId: 's1', title: 'Mine', cwd: '/w', busy: false, controller: null },
        {
          ref: OTHER,
          sessionId: 's2',
          title: 'Other',
          cwd: '/w',
          busy,
          controller: clientId ? { clientId, label: `Client ${clientId}` } : null,
        },
      ],
    })

  it.each(['lane.reload', 'contextFiles.set', 'mcp.lane'])(
    '%s on another lane is surface-only and respects its controller',
    async (op) => {
      const args = {
        ref: OTHER,
        ...(op === 'contextFiles.set' ? { agents: false } : {}),
        ...(op === 'mcp.lane' ? { server: 'gh', action: 'inspect' } : {}),
      }
      const h = controlled('c2')
      expect(await h.tool({ op, args })).toMatchObject({ status: 'denied', code: 'never' })
      expect(await h.run(surface('c1'), { op, args })).toMatchObject({ code: 'not-controller' })
      expect((await h.run(surface('c2'), { op, args })).status).toBe('ok')
      expect((await controlled(null).run(surface('c1'), { op, args })).status).toBe('ok')
    },
  )

  it('refuses a change to another lane mid-turn, except harmless marks', async () => {
    const h = controlled(null, true)
    expect(await h.tool({ op: 'lane.archive', args: { ref: OTHER } })).toMatchObject({
      status: 'denied',
      code: 'busy',
    })
    expect((await h.tool({ op: 'lane.rename', args: { ref: OTHER, name: 'n' } })).status).toBe('ok')
    expect((await h.tool({ op: 'lane.read', args: { ref: OTHER } })).status).toBe('ok')
  })

  it('refuses an unknown lane ref', async () => {
    const h = createHarness()
    expect(await h.tool({ op: 'lane.read', args: { ref: 'local/session:nope' } })).toMatchObject({
      code: 'bad-request',
    })
  })
})

describe('confirmations', () => {
  it('asks once, waits for approval, runs once, and never redeems twice', async () => {
    const h = createHarness()
    const request = { op: 'lane.delete', args: { ref: OTHER } }
    const asked = await h.tool(request)
    if (asked.status !== 'confirm') throw new Error('expected a confirm')
    expect(asked.timeoutMs).toBe(600_000)
    expect(h.calls.created[0]).toMatchObject({
      principal: agent(),
      sessionId: 's1',
      items: [{ hostId: null, op: 'lane.delete', ids: [OTHER], labels: ['Other'] }],
      lane: { ref: OTHER },
    })
    const confirm = { confirmId: asked.confirmId, digest: asked.digest }
    expect(await h.tool(request, { confirm })).toMatchObject({ code: 'confirm-denied' })
    h.approve(asked.confirmId)
    expect(await h.tool(request, { confirm })).toMatchObject({ status: 'ok' })
    expect(await h.tool(request, { confirm })).toMatchObject({ code: 'confirm-mismatch' })
    expect(h.calls.handled.map((c) => c.op)).toEqual(['lane.delete'])
    expect(h.calls.audit.map((r) => r.decision)).toEqual(['approved', 'denied-policy'])
  })

  it('serves confirm.status only to the principal that asked', async () => {
    const h = createHarness()
    const asked = await h.run(local(), { op: 'archive.purge', args: { ids: ['a'] } })
    if (asked.status !== 'confirm') throw new Error('expected a confirm')
    const status = { op: 'confirm.status', args: { confirmId: asked.confirmId } }
    expect(await h.run(local(), status)).toMatchObject({ status: 'ok' })
    expect(await h.run(agent(), status)).toMatchObject({ status: 'denied', code: 'forbidden' })
  })
})
