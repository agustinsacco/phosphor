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
  expect(
    await window.phosphor.invoke('control:approveEnrollment', 'BCDFGHJK', 'buildbox'),
  ).toMatchObject({ ok: true })
  expect(await window.phosphor.invoke('control:machines')).toMatchObject({ ok: true })
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
  expect(await window.phosphor.invoke('hosts:models', host)).toMatchObject([
    { id: 'claude-sonnet-4-5' },
  ])
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

it('dispatches the Brain v2 queue, review and knowledge channels', async () => {
  vi.useFakeTimers()
  const { DEFAULT_BRAIN_PREFS } = await import('@shared/brain')
  await window.phosphor.invoke('brain:setPrefs', { ...DEFAULT_BRAIN_PREFS, enabled: true })
  await vi.advanceTimersByTimeAsync(6000)
  const queued = await window.phosphor.invoke('brain:queue', {
    sessionPath: '/demo/Harbor/dispatch.jsonl',
    title: 'Harbor billing',
  })
  const id = queued.jobs[0]!.id
  expect((await window.phosphor.invoke('brain:status')).jobs[0]?.state).toBe('running')
  await vi.advanceTimersByTimeAsync(5000)
  const proposal = await window.phosphor.invoke('brain:proposal', id)
  expect(proposal.memories.length).toBeGreaterThan(0)
  await window.phosphor.invoke('brain:review', id, [0], proposal.revision)
  const knowledge = await window.phosphor.invoke('brain:knowledge')
  expect(knowledge.memories).toHaveLength(1)
  expect(
    (await window.phosphor.invoke('brain:memory', knowledge.memories[0]!.id)).quotes,
  ).toHaveLength(1)
  await window.phosphor.invoke('brain:forget', knowledge.memories[0]!.id)
  expect((await window.phosphor.invoke('brain:knowledge')).memories).toEqual([])
})
