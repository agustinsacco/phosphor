// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installMockPhosphor } from './mockPhosphor'
import { CLAUDE_PROVIDER_PACKAGE } from '@shared/models'
beforeEach(() => {
  localStorage.clear()
  installMockPhosphor()
})
afterEach(() => vi.useRealTimers())
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
    (async () => window.phosphor.invoke('hosts:machineTask', host, 'claude-login'))(),
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
