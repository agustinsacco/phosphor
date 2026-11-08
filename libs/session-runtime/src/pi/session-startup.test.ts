import { describe, expect, it, vi } from 'vitest'
import { sessionFixture } from './__fixtures__/session-runtime'
import { RATE_LIMIT_STATUS_KEY } from '@shared/claude-limits'

vi.mock('electron', () => {
  throw new Error('Startup imported Electron')
})

describe('portable startup', () => {
  it('normalizes cwd, waits for pi, records recents, and emits whole events', async () => {
    const h = sessionFixture()
    vi.mocked(h.runtime.resolveWorkspace).mockReturnValue('/real/repo')
    const session = await h.spawn({ workspacePath: '/alias' }, h.sink)
    expect(session.workspacePath).toBe('/real/repo')
    expect(h.runtime.policy.git).toHaveBeenCalledWith('/real/repo')
    expect(h.runtime.recordWorkspace).toHaveBeenCalledWith('/real/repo', 'repo')
    expect(h.clients[0]!.request.mock.calls.map(([c]) => c.type)).toEqual(['get_state', 'prompt'])
    const event = { type: 'message_update', delta: 'whole payload' }
    h.clients[0]!.emit('event', event)
    expect(h.emit).toHaveBeenCalledWith({ kind: 'event', event })
    await h.registry.disposeAll()
  })

  it('does not allocate a process after cancellation during policy preparation', async () => {
    const h = sessionFixture()
    const controller = new AbortController()
    vi.mocked(h.runtime.policy.resetCompaction).mockImplementation(async () => controller.abort())
    await expect(
      h.spawn({ workspacePath: '/repo' }, h.sink, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.clients).toHaveLength(0)
    expect(h.runtime.recordWorkspace).not.toHaveBeenCalled()
  })

  it('interrupts a hung startup and removes its abort listener after disposal', async () => {
    const h = sessionFixture()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    h.registry.on('created', () => {
      const client = h.clients[0]!
      let fail!: (error: Error) => void
      client.request.mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            fail = reject
          }),
      )
      client.dispose.mockImplementation(async () => {
        client.alive = false
        fail(new Error('stopped'))
        client.emit('exit', { expected: true })
      })
    })
    const started = h.spawn({ workspacePath: '/repo' }, h.sink, { signal: controller.signal })
    const outcome = started.catch((error: Error) => error.name)
    await vi.waitFor(() => expect(h.clients[0]?.request).toHaveBeenCalled())
    controller.abort()
    expect(await outcome).toBe('AbortError')
    expect(h.registry.list()).toEqual([])
    expect(h.clients[0]!.dispose).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it.each(['sink', 'readiness', 'bookkeeping'])(
    'disposes the writer on %s failure',
    async (failure) => {
      const h = sessionFixture()
      if (failure === 'readiness')
        h.registry.on('created', () =>
          h.clients[0]!.request.mockRejectedValue(new Error('readiness')),
        )
      if (failure === 'bookkeeping')
        vi.mocked(h.runtime.recordWorkspace).mockImplementation(() => {
          throw new Error('bookkeeping')
        })
      const sink =
        failure === 'sink'
          ? () => {
              throw new Error('sink')
            }
          : h.sink
      await expect(h.spawn({ workspacePath: '/repo' }, sink)).rejects.toThrow(failure)
      expect(h.registry.list()).toEqual([])
      expect(h.clients[0]!.dispose).toHaveBeenCalledOnce()
      expect(h.runtime.accounts.forget).toHaveBeenCalledOnce()
    },
  )

  it('remembers the selected account, holds it on exhaustion, and skips unattended recents', async () => {
    const h = sessionFixture()
    vi.mocked(h.runtime.policy.defaultProvider).mockResolvedValue('pi-claude-cli')
    vi.mocked(h.runtime.policy.packages).mockResolvedValue([
      { name: '@saccolabs/pi-claude-cli', version: '0.10.0', installed: true },
    ])
    vi.mocked(h.runtime.policy.account).mockResolvedValue({ id: 'account', env: {} })
    const session = await h.spawn({ workspacePath: '/repo' }, h.sink, { unattended: true })
    expect(h.runtime.accounts.remember).toHaveBeenCalledWith(session.sessionId, 'account')
    expect(h.runtime.recordWorkspace).not.toHaveBeenCalled()
    const resetsAt = Math.floor(Date.now() / 1000) + 60
    const request = {
      method: 'setStatus',
      statusKey: RATE_LIMIT_STATUS_KEY,
      statusText: JSON.stringify({ utilization: 1, resetsAt }),
    }
    h.clients[0]!.emit('extension-ui', request)
    expect(h.runtime.accounts.hold).toHaveBeenCalledWith('account', resetsAt * 1000)
    expect(h.emit).toHaveBeenCalledWith({ kind: 'extension-ui', request })
    expect(vi.mocked(h.runtime.accounts.hold).mock.invocationCallOrder[0]).toBeLessThan(
      h.emit.mock.invocationCallOrder[0]!,
    )
    await h.registry.disposeAll()
  })

  it('adds Brain recall to a lane, and starts the lane without it when recall fails', async () => {
    const h = sessionFixture()
    h.runtime.recall = vi.fn(async () => ({
      env: { PHOSPHOR_BRAIN_TOKEN: 't' },
      extensions: ['/res/brain.mjs'],
      skills: ['/res/skills/brain'],
    }))
    await h.spawn({ workspacePath: '/repo' }, h.sink)
    expect(h.clients[0]!.options).toMatchObject({
      env: { PHOSPHOR_BRAIN_TOKEN: 't' },
      extensions: ['/res/brain.mjs'],
      skills: ['/res/skills/brain'],
    })
    h.runtime.recall = vi.fn(async () => Promise.reject(new Error('worker down')))
    await h.spawn({ workspacePath: '/repo' }, h.sink)
    expect(h.clients[1]!.options.skills).toBeUndefined()
    expect(h.runtime.log).toHaveBeenCalledWith('brain', 'recall unavailable', {
      error: 'Error: worker down',
    })
    await h.registry.disposeAll()
  })

  it('gives the pi stub no recall', async () => {
    const h = sessionFixture()
    vi.mocked(h.runtime.launch).mockResolvedValue({ stub: true, env: {}, extensions: [] } as never)
    h.runtime.recall = vi.fn(async () => ({ env: {}, extensions: ['/x'], skills: [] }))
    await h.spawn({ workspacePath: '/repo' }, h.sink).catch(() => undefined)
    expect(h.runtime.recall).not.toHaveBeenCalled()
    await h.registry.disposeAll()
  })
})
