import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RATE_LIMIT_STATUS_KEY } from '@shared/claude-limits'
import { sessionFixture } from './__fixtures__/session-runtime'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
function fixture() {
  const h = sessionFixture()
  cleanups.push(() => h.registry.disposeAll())
  return h
}

describe('session startup characterization', () => {
  it('heals the stored cwd before launch and captures lane config before spawning', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phosphor-startup-characterization-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const path = join(dir, 'session.jsonl')
    await writeFile(path, JSON.stringify({ type: 'session', cwd: join(dir, 'gone') }) + '\n')
    const h = fixture()
    const order: string[] = []
    const launch = h.runtime.launch
    h.runtime.launch = async () => {
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ type: 'session', cwd: dir })
      order.push('launch')
      return launch()
    }
    const capture = vi.fn(async () => {
      order.push('capture')
      return 'snapshot'
    })
    const track = vi.fn()
    h.runtime.laneReload = { capture, track }
    h.registry.on('created', () => order.push('spawn'))
    const live = await h.spawn({ workspacePath: dir, sessionPath: path }, h.sink)
    expect(order).toEqual(['launch', 'capture', 'spawn'])
    expect(capture).toHaveBeenCalledWith(dir)
    expect(track).toHaveBeenCalledWith(live.sessionId, 'snapshot', h.clients[0])
    expect(h.runtime.log).toHaveBeenCalledWith('pi', 'repointed session cwd', { path })
  })

  it('holds an exhausted account before delivering status and omits unattended recents', async () => {
    const h = fixture()
    vi.mocked(h.runtime.policy.defaultProvider).mockResolvedValue('pi-claude-cli')
    vi.mocked(h.runtime.policy.packages).mockResolvedValue([
      { name: '@saccolabs/pi-claude-cli', version: '0.10.0', installed: true },
    ])
    vi.mocked(h.runtime.policy.account).mockResolvedValue({ id: 'account', env: {} })
    const live = await h.spawn({ workspacePath: '/repo' }, h.sink, { unattended: true })
    expect(h.runtime.accounts.remember).toHaveBeenCalledWith(live.sessionId, 'account')
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
  })

  it('disposes aborted startup, forgets the account and removes its listener', async () => {
    const h = fixture()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    h.registry.on('created', () => {
      const client = h.clients[0]!
      client.request.mockImplementation(async () => {
        controller.abort()
        throw new Error('stopped')
      })
    })
    await expect(
      h.spawn({ workspacePath: '/repo' }, h.sink, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.registry.list()).toEqual([])
    expect(h.clients[0]!.dispose).toHaveBeenCalledOnce()
    expect(h.runtime.accounts.forget).toHaveBeenCalledOnce()
    expect(h.clients[0]!.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(h.runtime.accounts.forget).mock.invocationCallOrder[0]!,
    )
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(h.runtime.recordWorkspace).not.toHaveBeenCalled()
  })
})
