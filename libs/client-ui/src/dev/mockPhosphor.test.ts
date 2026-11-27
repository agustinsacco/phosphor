// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installMockPhosphor } from './mockPhosphor'
import { CLAUDE_PROVIDER_PACKAGE } from '@shared/models'
beforeEach(() => {
  localStorage.clear()
  installMockPhosphor()
})
afterEach(() => vi.useRealTimers())
it('characterizes local routine routing, Host refusal and Brain dispatch', async () => {
  const snapshot = await window.phosphor.invoke('routines:list')
  expect(snapshot).toMatchObject({ routines: [], runs: [], background: false, error: null })
  await expect(window.phosphor.invoke('routines:list', 'host:remote')).rejects.toThrow(
    'Machine routines are unavailable in the browser harness.',
  )
  expect(await window.phosphor.invoke('routines:list')).toEqual(snapshot)
  expect(await window.phosphor.invoke('brain:status')).toMatchObject({ supported: true })
})
it('keeps control signed out by default and supports first-class enrollment', async () => {
  await window.phosphor.invoke('account:signOut')
  expect(await window.phosphor.invoke('control:machines')).toMatchObject({
    error: { code: 'signed-out' },
  })
  vi.useFakeTimers()
  await window.phosphor.invoke('account:signIn')
  await vi.advanceTimersByTimeAsync(1500)
  expect(await window.phosphor.invoke('control:lookupEnrollment', 'BCDFGHJK')).toMatchObject({
    ok: true,
    hostname: 'buildbox',
  })
  const approval = await window.phosphor.invoke('control:approveEnrollment', 'BCDFGHJK', 'buildbox')
  if (!approval.ok) throw new Error('mock enrollment failed')
  const id = approval.machine.id
  expect(await window.phosphor.invoke('control:machines')).toMatchObject({
    machines: [{ id, machineGrants: true, machineReach: true }],
  })
  expect(await window.phosphor.invoke('control:setMachineReach', id, false)).toEqual({
    ok: true,
    machineReach: false,
  })
  expect(await window.phosphor.invoke('control:machines')).toMatchObject({
    machines: [{ id, machineReach: false }],
  })
  await window.phosphor.invoke('account:signOut')
  expect(await window.phosphor.invoke('control:machines')).toMatchObject({
    error: { code: 'signed-out' },
  })
})
it("answers app:about, so This Mac's Details and Settings → Advanced show a version", async () => {
  expect(await window.phosphor.invoke('app:about')).toMatchObject({
    appVersion: '0.0.0-dev',
    platform: window.phosphor.platform,
  })
})
it("lists This Mac's Claude provider by its package name, as the provider row matches it", async () => {
  const packages = await window.phosphor.invoke('packages:list')
  expect(packages.find((entry) => entry.spec === `npm:${CLAUDE_PROVIDER_PACKAGE}`)?.name).toBe(
    CLAUDE_PROVIDER_PACKAGE,
  )
})
it('answers each delegated channel group from its owning mock module', async () => {
  const host = '00000000-0000-4000-8000-000000000099'
  expect(await window.phosphor.invoke('hosts:models', host)).toMatchObject({
    models: [{ id: 'claude-sonnet-4-5' }],
    defaults: { model: { provider: 'anthropic', id: 'claude-sonnet-4-5' } },
  })
  await expect(
    (async () => window.phosphor.invoke('hosts:machineTask', host, {} as never))(),
  ).rejects.toThrow('Private setup terminals')
  expect(
    await window.phosphor.invoke('hosts:skillExport', { machine: host, name: 'demo' }),
  ).toMatchObject({
    name: 'demo',
    files: [{ path: 'SKILL.md' }],
  })
  expect(await window.phosphor.invoke('hosts:exportLaneHtml', 'remote-lane')).toMatchObject({
    html: expect.stringContaining('Mock lane'),
  })
  expect(await window.phosphor.invoke('sessions:worktreeRecovery', '/tmp/s.jsonl')).toMatchObject({
    fresh: { branch: 'phosphor/mock-lane' },
  })
  expect(await window.phosphor.invoke('pi:readInstructions')).toMatchObject({
    path: '/Users/dev/.pi/agent/AGENTS.md',
  })
})

it("answers agent ops, This Mac's runtime from their stub modules", async () => {
  expect(
    await window.phosphor.invoke('ops:run', { kind: 'local' }, { op: 'help', args: {} }),
  ).toMatchObject({ status: 'denied', code: 'unsupported' })
  expect(await window.phosphor.invoke('app:localMachine')).toEqual({
    mode: 'in-app',
    migration: 'not-needed',
    brainOwner: 'desktop',
  })
  expect(await window.phosphor.invoke('app:localMachineAction', 'retry-migration')).toMatchObject({
    ok: false,
  })
  await window.phosphor.invoke('account:signOut')
  expect(await window.phosphor.invoke('control:setMachineReach', 'machine', true)).toMatchObject({
    ok: false,
    error: { code: 'signed-out' },
  })
})

it('dispatches the Brain queue, Defrag and Explorer channels', async () => {
  vi.useFakeTimers()
  const { DEFAULT_BRAIN_PREFS } = await import('@shared/brain')
  await window.phosphor.invoke('brain:setPrefs', { ...DEFAULT_BRAIN_PREFS, enabled: true })
  await vi.advanceTimersByTimeAsync(6000)
  const queued = await window.phosphor.invoke('brain:queue', {
    sessionPath: '/demo/Harbor/dispatch.jsonl',
    title: 'Harbor billing',
  })
  const id = queued.jobs.at(-1)!.id
  // The harness reads its own queued lane first; each read saves after four seconds.
  for (let step = 0; step < 6; step++) {
    await window.phosphor.invoke('brain:status')
    await vi.advanceTimersByTimeAsync(2500)
  }
  expect((await window.phosphor.invoke('brain:status')).jobs.map((job) => job.id)).not.toContain(id)
  expect((await window.phosphor.invoke('brain:extraction', id)).memories).toHaveLength(2)
  const answer = await window.phosphor.invoke('brain:ask', 'Who does Tom Lee report to?')
  expect(answer.hits.map((hit) => hit.memory.summary)).toContain('Tom Lee reports to Mara Voss.')
  expect(await window.phosphor.invoke('brain:tell', 'Tom Lee left the team')).toHaveProperty(
    'sessionPath',
  )
  await window.phosphor.invoke('brain:defrag')
  await vi.advanceTimersByTimeAsync(60_000)
  await window.phosphor.invoke('brain:status')
  await vi.advanceTimersByTimeAsync(60_000)
  expect((await window.phosphor.invoke('brain:status')).agent.run?.state).toBe('done')
  const knowledge = await window.phosphor.invoke('brain:entityMemories', 'ledger', {}, null)
  expect(knowledge.memories.length).toBeGreaterThan(0)
  expect(
    (await window.phosphor.invoke('brain:memory', knowledge.memories[0]!.id)).quotes,
  ).toHaveLength(1)
  await window.phosphor.invoke('brain:forget', knowledge.memories[0]!.id)
  expect(
    (await window.phosphor.invoke('brain:entityMemories', 'ledger', {}, null)).memories.map(
      (m) => m.id,
    ),
  ).not.toContain(knowledge.memories[0]!.id)
})

it('round trips the Brain reader preference through the browser bridge', async () => {
  const status = await window.phosphor.invoke('brain:status')
  expect(status.prefs).toHaveProperty('model', null)
  const prefs = { ...status.prefs, model: 'harbor/reader' }
  expect((await window.phosphor.invoke('brain:setPrefs', prefs)).prefs).toEqual(prefs)
})

it('exposes the map owner in the browser harness', async () => {
  expect((await window.phosphor.invoke('brain:status')).ownerId).toBe('mara')
})
