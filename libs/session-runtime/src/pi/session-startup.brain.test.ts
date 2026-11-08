import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrainExecutionProfile } from './brain-execution-profile'
import { sessionFixture } from './__fixtures__/session-runtime'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'brain-startup-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const profile: BrainExecutionProfile = {
    owner: { kind: 'brain', jobId: 'job-1' },
    cwd: join(root, 'cwd'),
    agentDir: join(root, 'agent'),
    sessionDir: join(root, 'sessions'),
    binaryPath: process.execPath,
    provider: 'synthetic',
    modelId: 'exact-model',
    processorExtension: join(root, 'brain-processor.ts'),
    providerExtension: join(root, 'audited-provider.ts'),
  }
  await Promise.all([profile.cwd, profile.agentDir, profile.sessionDir].map((dir) => mkdir(dir)))
  const h = sessionFixture()
  cleanups.push(() => h.registry.disposeAll())
  h.registry.on('created', () =>
    h.clients[0]!.request.mockResolvedValue({
      success: true,
      data: { model: { provider: 'synthetic', id: 'exact-model' } },
    } as never),
  )
  return { ...h, profile }
}

it('publishes owner before capture, skips all interactive startup side effects, and checks the exact model', async () => {
  const h = await fixture()
  const created = vi.fn((session) => {
    expect(session.owner).toEqual({ kind: 'brain', jobId: 'job-1' })
    expect(Object.isFrozen(session.owner)).toBe(true)
  })
  h.registry.on('created', created)
  const watch = vi.spyOn(h.runtime.budget, 'watch')
  const capture = vi.fn(async () => 'user-config')
  const track = vi.fn()
  const prepare = vi.fn(async () => undefined)
  h.runtime.memory = { prepare }
  h.runtime.laneReload = { capture, track }
  const info = await h.spawn({ workspacePath: h.profile.cwd }, h.sink, { brain: h.profile })
  expect(h.registry.get(info.sessionId)?.owner).toEqual(h.profile.owner)
  expect(created).toHaveBeenCalledOnce()
  expect(h.clients[0]!.request.mock.calls.map(([command]) => command)).toEqual([
    { type: 'get_state' },
  ])
  h.clients[0]!.emit('event', { type: 'agent_settled' })
  expect(h.clients[0]!.request).toHaveBeenCalledOnce()
  for (const callback of [
    h.runtime.resolveWorkspace,
    h.runtime.launch,
    h.runtime.recordWorkspace,
    h.runtime.accounts.remember,
    h.runtime.policy.git,
    h.runtime.policy.defaultProvider,
    h.runtime.policy.account,
    h.runtime.policy.resetCompaction,
    watch,
    capture,
    track,
    prepare,
  ])
    expect(callback).not.toHaveBeenCalled()
})

it('disposes the owned process on actual model mismatch without any fallback or prompt', async () => {
  const h = await fixture()
  h.registry.on('created', () =>
    h.clients[0]!.request.mockResolvedValue({
      success: true,
      data: { model: { provider: 'synthetic', id: 'wrong-model' } },
    } as never),
  )
  await expect(
    h.spawn({ workspacePath: h.profile.cwd }, h.sink, { brain: h.profile }),
  ).rejects.toThrow('readiness failed')
  expect(h.registry.list()).toEqual([])
  expect(h.clients[0]!.dispose).toHaveBeenCalledOnce()
  expect(h.clients[0]!.request.mock.calls.map(([command]) => command)).toEqual([
    { type: 'get_state' },
  ])
})
