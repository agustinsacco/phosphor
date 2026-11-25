import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionFixture } from './__fixtures__/session-runtime'
import { createSessionService, type SessionServiceRuntime } from './session-service'
import { createSessionPathRuntime } from './session-path-lock'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function fixture() {
  const h = sessionFixture()
  cleanups.push(() => h.registry.disposeAll())
  const runtime: SessionServiceRuntime<undefined> = {
    registry: h.registry,
    paths: createSessionPathRuntime(),
    spawn: vi.fn((options, _delivery, execution) => h.spawn(options, h.sink, execution)),
    isStub: () => false,
    packages: h.runtime.policy.packages,
    readBudget: h.runtime.budget.read,
    withBudgetCompaction: h.budget.withBudgetCompaction,
    forgetAccount: h.runtime.accounts.forget,
    routines: {
      owns: vi.fn(() => false),
      sessionForPath: vi.fn((): string | undefined => undefined),
      observe: vi.fn(),
      cancel: vi.fn(async () => {}),
    },
  }
  return { ...h, runtime, service: createSessionService(runtime) }
}

async function transcript() {
  const dir = await mkdtemp(join(tmpdir(), 'phosphor-admission-characterization-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'session.jsonl')
  await writeFile(path, '{}\n')
  return { dir, path }
}

describe('session service characterization', () => {
  it('adopts a routine lane before checking its unwritten transcript', async () => {
    const h = fixture()
    const live = await h.service.create({ workspacePath: '/repo' })
    vi.mocked(h.runtime.routines.sessionForPath).mockReturnValue(live.sessionId)
    vi.mocked(h.runtime.spawn).mockClear()
    const open = vi.spyOn(h.runtime.paths, 'openSessionPath')
    expect(
      await h.service.create({ workspacePath: '/repo', sessionPath: '/not-yet-written' }),
    ).toEqual(live)
    expect(open).not.toHaveBeenCalled()
    expect(h.runtime.spawn).not.toHaveBeenCalled()
  })

  it('disposes a dead owner before respawn and refuses a missing transcript', async () => {
    const { dir, path } = await transcript()
    const h = fixture()
    const old = await h.service.create({ workspacePath: dir, sessionPath: path })
    const dispose = h.clients[0]!.dispose
    h.clients[0]!.alive = false
    const resumed = await h.service.create({ workspacePath: dir, sessionPath: path })
    expect(resumed.sessionId).not.toBe(old.sessionId)
    expect(h.registry.get(old.sessionId)).toBeUndefined()
    expect(dispose.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(h.runtime.spawn).mock.invocationCallOrder[1]!,
    )
    await expect(
      h.service.create({ workspacePath: dir, sessionPath: join(dir, 'gone') }),
    ).rejects.toThrow('ENOENT')
    expect(h.clients).toHaveLength(2)
  })

  it('rejects cancellation before queue registration and cancels queued opens before spawn', async () => {
    const { dir, path } = await transcript()
    const h = fixture()
    const controller = new AbortController()
    controller.abort()
    const open = vi.spyOn(h.runtime.paths, 'openSessionPath')
    await expect(
      h.service.create({ workspacePath: dir, sessionPath: path }, undefined, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(open).not.toHaveBeenCalled()
    let release!: () => void
    const blocker = h.runtime.paths.withSessionPath(
      path,
      () => new Promise<void>((resolve) => (release = resolve)),
    )
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const queued = h.service.create({ workspacePath: dir, sessionPath: path })
    const outcome = expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    h.runtime.paths.cancelSessionOpens(path)
    release()
    await blocker
    await outcome
    expect(h.runtime.spawn).not.toHaveBeenCalled()
  })

  it('reloads a prompt before synchronizing the current context budget', async () => {
    const h = fixture()
    const live = await h.service.create({ workspacePath: '/repo' })
    const client = h.clients[0]!
    client.request.mockClear()
    h.runtime.laneReload = {
      beforePrompt: vi.fn(async () => {
        await client.request({ type: 'prompt', message: '/phosphor-reload token' })
        return 'applied' as const
      }),
    }
    vi.mocked(h.runtime.readBudget).mockReturnValue('400k')
    await h.service.command(live.sessionId, { type: 'prompt', message: 'go' })
    expect(client.request.mock.calls.map(([command]) => command)).toEqual([
      { type: 'get_state' },
      { type: 'prompt', message: '/phosphor-reload token' },
      { type: 'get_state' },
      { type: 'prompt', message: '/phosphor-context-budget 400000' },
      { type: 'prompt', message: 'go' },
    ])
  })

  it('rechecks routine ownership after waiting without dispatching a mutation', async () => {
    const h = fixture()
    const live = await h.service.create({ workspacePath: '/repo' })
    h.runtime.withBudgetCompaction = async (_id, _type, action) => {
      vi.mocked(h.runtime.routines.owns).mockReturnValue(true)
      return action()
    }
    h.clients[0]!.request.mockClear()
    await expect(h.service.command(live.sessionId, { type: 'compact' })).rejects.toThrow(
      'owned by a running routine',
    )
    expect(h.clients[0]!.request).not.toHaveBeenCalled()
  })
})
