import { afterEach, describe, expect, it, vi } from 'vitest'
import { sessionFixture } from './__fixtures__/session-runtime'
import type { SpawnContribution } from './spawn-contributions'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
function fixture(contributions: SpawnContribution[]) {
  const h = sessionFixture()
  h.runtime.contributions = contributions
  cleanups.push(() => h.registry.disposeAll())
  return h
}

describe('spawn contributions', () => {
  it('adds env, extensions and skills in order and attaches to the started session', async () => {
    const attach = vi.fn()
    const spawn = vi.fn(() => ({ env: { A: '1' }, extensions: ['/a.ts'], skills: ['/a'] }))
    const h = fixture([
      { name: 'first', spawn, attach },
      { name: 'second', spawn: async () => ({ env: { A: '2', B: '2' }, extensions: ['/b.ts'] }) },
      { name: 'none', spawn: () => undefined },
    ])
    const live = await h.spawn({ workspacePath: '/repo' }, h.sink, { unattended: true })
    expect(h.clients[0]!.options).toMatchObject({
      env: { A: '2', B: '2' },
      extensions: ['/a.ts', '/b.ts'],
      skills: ['/a'],
    })
    expect(spawn).toHaveBeenCalledWith(
      { unattended: true },
      { options: expect.objectContaining({ workspacePath: '/repo' }) },
    )
    expect(attach).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: live.sessionId }),
      expect.objectContaining({ execution: { unattended: true } }),
    )
  })

  it('logs and skips a failing contributor so the lane still starts', async () => {
    const h = fixture([
      { name: 'broken', spawn: () => Promise.reject(new Error('down')) },
      {
        name: 'throws-on-attach',
        spawn: () => ({ env: { KEPT: 'yes' } }),
        attach: () => {
          throw new Error('attach')
        },
      },
    ])
    await h.spawn({ workspacePath: '/repo' }, h.sink)
    expect(h.clients[0]!.options.env).toEqual({ KEPT: 'yes' })
    expect(h.runtime.log).toHaveBeenCalledWith('pi', 'spawn contribution unavailable', {
      contribution: 'broken',
      error: 'Error: down',
    })
    expect(h.runtime.log).toHaveBeenCalledWith('pi', 'spawn contribution attach failed', {
      contribution: 'throws-on-attach',
      error: 'Error: attach',
    })
  })

  it('never applies to a stub launch', async () => {
    const spawn = vi.fn(() => ({ env: { NO: 'no' } }))
    const attach = vi.fn()
    const h = fixture([{ name: 'skipped', spawn, attach }])
    h.runtime.launch = async () => ({ stub: true, env: {}, extensions: [] })
    await h.spawn({ workspacePath: '/repo' }, h.sink)
    expect(spawn).not.toHaveBeenCalled()
    expect(attach).not.toHaveBeenCalled()
    expect(h.clients[0]!.options.env).toEqual({})
  })
})
