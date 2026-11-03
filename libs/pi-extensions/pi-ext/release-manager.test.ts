import { hostname } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { releaseOrigin, type ReleaseOrigin } from '../test/__fixtures__/release-origin'
import { claimLease, LEASE_RENEW_MS, readState, runner, type Run } from './release-lease'
import releaseManager, { savedRelease, SWEEP_MS, WATCH_MS } from './release-manager'
import { RELEASE_SECTION } from './release-prompt'
import { parseReleaseStatus, RELEASE_COMMAND, RELEASE_STATUS_KEY } from './release-status'
import { RELEASE_TOOLS } from './release-tools'

const T = Date.parse('2026-11-02T12:00:00Z')
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
let origin: ReleaseOrigin
let clock = T
let inflight = 0
let prs: unknown[] = []
const gh = vi.fn(async (args: string[]) => (args[0] === 'pr' ? JSON.stringify(prs) : '[]'))

const track =
  (run: Run): Run =>
  async (args, input) => {
    inflight++
    try {
      return await run(args, input)
    } finally {
      inflight--
    }
  }

/** Wait until no git or gh command has been in flight for a while: the tick is done. */
async function settle() {
  for (let calm = 0; calm < 3;) {
    await sleep(15)
    calm = inflight === 0 ? calm + 1 : 0
  }
}

async function tick(ms = WATCH_MS) {
  clock += ms
  vi.advanceTimersByTime(WATCH_MS)
  await settle()
}

function lane(sessionId: string, branch: unknown[] = [], wrap = (git: Run) => git) {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>()
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>()
  let active = ['read', 'bash']
  let handler!: (args: string, ctx: unknown) => Promise<void>
  const pi = {
    on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) =>
      void handlers.set(name, [...(handlers.get(name) ?? []), fn]),
    registerTool: (tool: Record<string, unknown>) =>
      void tools.set(tool.name as string, tool as never),
    registerCommand: (_name: string, spec: { handler: typeof handler }) => {
      handler = spec.handler
    },
    appendEntry: vi.fn((customType: string, data: unknown) =>
      branch.push({ type: 'custom', customType, data }),
    ),
    sendMessage: vi.fn(),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names
    },
  }
  const ctx = {
    cwd: origin.work,
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
    ui: { setStatus: vi.fn() },
  }
  releaseManager(
    pi,
    () => clock,
    (command, cwd) => track(command === 'gh' ? gh : wrap(runner(command, cwd))),
  )
  const emit = (name: string, event: unknown = {}) =>
    handlers.get(name)?.map((fn) => fn(event, ctx))[0]
  emit('session_start')
  return {
    pi,
    ctx,
    branch,
    emit,
    tools,
    active: () => active,
    status: () => parseReleaseStatus(ctx.ui.setStatus.mock.lastCall?.[1]),
    passes: () =>
      pi.sendMessage.mock.calls.map(([message]) => (message as { content: string }).content),
    command: async (args: string) => {
      await handler(args, ctx)
      await settle()
    },
    prompt: () => {
      const messages = [{ role: 'system', sections: {} as Record<string, string> }]
      emit('context_with_system', { messages })
      return messages[0]!.sections[RELEASE_SECTION] ?? ''
    },
    bash: (command: string) => emit('tool_call', { toolName: 'bash', input: { command } }),
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  clock = T
  prs = []
  gh.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  origin.cleanup()
})

describe('release mode', () => {
  it('stays dormant in a repository without a release policy', async () => {
    origin = await releaseOrigin(null)
    const a = lane('one')
    expect(a.ctx.ui.setStatus).toHaveBeenLastCalledWith(RELEASE_STATUS_KEY, undefined)
    await expect(a.command('on')).rejects.toThrow(/release-setup/)
    expect(a.bash('gh pr merge 1')).toBeUndefined()
    expect(a.prompt()).toBe('')
    expect(gh).not.toHaveBeenCalled()
  })

  it('takes the free lease and starts the first pass with the release tools', async () => {
    origin = await releaseOrigin()
    const a = lane('one')
    expect(a.status()).toMatchObject({ available: true, enabled: false, role: 'off' })
    await a.command('on')
    expect(a.status()).toMatchObject({
      enabled: true,
      role: 'active',
      holder: hostname(),
      epoch: 1,
    })
    expect(a.active()).toEqual(['read', 'bash', ...RELEASE_TOOLS])
    expect(a.passes()).toHaveLength(1)
    expect(a.passes()[0]).toContain('Release pass 1 (epoch 1, base main).')
    expect(a.passes()[0]).toContain('read the queue in full')
    expect(a.pi.sendMessage.mock.lastCall?.[1]).toEqual({
      triggerTurn: true,
      deliverAs: 'followUp',
    })
    expect(a.prompt()).toContain('This lane holds the release lease (epoch 1).')
    expect(a.bash('gh pr merge 1 --squash')).toMatchObject({ block: true })
    expect(a.branch).toContainEqual({
      type: 'custom',
      customType: RELEASE_COMMAND,
      data: { enabled: true, sessionId: 'one' },
    })
  })

  it('passes only when GitHub changes, and sweeps while work waits', async () => {
    origin = await releaseOrigin()
    const a = lane('one')
    await a.command('on')
    await tick()
    expect(a.passes()).toHaveLength(1)
    prs = [
      {
        number: 5,
        headRefOid: 'b'.repeat(40),
        isDraft: false,
        baseRefName: 'main',
        mergeable: 'MERGEABLE',
        labels: [],
        statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
      },
    ]
    await tick()
    expect(a.passes()).toHaveLength(2)
    expect(a.passes()[1]).toContain('Changed since the last pass:\n+ #5 bbbbbbb ready')
    await tick()
    expect(a.passes()).toHaveLength(2)
    await tick(SWEEP_MS)
    expect(a.passes()[2]).toContain('Periodic sweep')
  })

  it('stands by while another lane holds the lease, and takes over on request', async () => {
    origin = await releaseOrigin()
    const a = lane('one')
    await a.command('on')
    const b = lane('two')
    await b.command('on')
    expect(b.status()).toMatchObject({ enabled: true, role: 'standby', epoch: 1 })
    expect(b.active()).toEqual(['read', 'bash'])
    expect(b.passes()).toEqual([])
    expect(b.prompt()).toContain('another lane holds')
    await b.command('takeover')
    expect(b.status()).toMatchObject({ role: 'active', epoch: 2 })
    expect(b.passes()[0]).toContain('epoch 2')
    await tick(LEASE_RENEW_MS)
    expect(a.status()).toMatchObject({ role: 'standby', epoch: 2 })
    expect(a.active()).toEqual(['read', 'bash'])
  })

  it('says so, and names the winner, when a takeover loses a race', async () => {
    origin = await releaseOrigin()
    const a = lane('one')
    await a.command('on')
    let race = false
    const stark = { holder: 'stark/x', host: 'stark', pid: process.pid }
    const b = lane('two', [], (git) => async (args, input) => {
      if (race && args[0] === 'push') {
        race = false
        await claimLease(origin.git, 'refs/test/s', stark, clock, true)
      }
      return git(args, input)
    })
    await b.command('on')
    race = true
    await expect(b.command('takeover')).rejects.toThrow(/took the release lease first/)
    await settle()
    expect(b.status()).toMatchObject({ role: 'standby', holder: 'stark', epoch: 2 })
  })

  it('keeps release runs quiet unless a person joins or the pass is flagged', async () => {
    origin = await releaseOrigin()
    const a = lane('one')
    await a.command('on')
    a.emit('before_agent_start', { messageType: 'custom' })
    expect(a.status()?.quiet).toBe(true)
    a.emit('input', { source: 'extension' })
    expect(a.status()?.quiet).toBe(true)
    a.emit('input', { source: 'rpc', streamingBehavior: 'steer' })
    expect(a.status()?.quiet).toBe(false)
    a.emit('before_agent_start', { messageType: 'custom' })
    expect(a.status()?.quiet).toBe(true)
    a.emit('input', { source: 'interactive' })
    a.emit('before_agent_start', { messageType: 'user' })
    expect(a.status()?.quiet).toBe(false)
    a.emit('before_agent_start', { messageType: 'custom' })
    await a.tools.get('release_flag')!.execute('call', {})
    expect(a.status()?.quiet).toBe(false)
  })

  it('hands the lease over when switched off', async () => {
    origin = await releaseOrigin()
    const a = lane('one')
    await a.command('on')
    await a.command('off')
    expect(a.status()).toMatchObject({ enabled: false, role: 'off', quiet: false })
    expect(a.active()).toEqual(['read', 'bash'])
    expect(a.bash('gh pr merge 1')).toBeUndefined()
    const { lease } = await readState(origin.git, 'refs/test/check')
    expect(Date.parse(lease!.expires)).toBeLessThanOrEqual(clock)
  })

  it('restores release mode only in the session that switched it on', async () => {
    origin = await releaseOrigin()
    const a = lane('one')
    await a.command('on')
    a.emit('session_shutdown')
    expect(savedRelease(a.branch, 'one')).toBe(true)
    const fork = lane('fork', [...a.branch])
    expect(fork.status()).toMatchObject({ enabled: false, role: 'off' })
    const again = lane('one', [...a.branch])
    await settle()
    expect(again.status()).toMatchObject({ enabled: true, role: 'active', epoch: 1 })
  })

  it('does nothing after shutdown, and reports a GitHub failure as the problem', async () => {
    origin = await releaseOrigin()
    const a = lane('one')
    await a.command('on')
    gh.mockRejectedValueOnce(new Error('gh pr failed: HTTP 502'))
    prs = []
    await tick()
    expect(a.status()?.problem).toBe('gh pr failed: HTTP 502')
    await tick()
    expect(a.status()?.problem).toBeUndefined()
    a.emit('session_shutdown')
    const calls = gh.mock.calls.length
    await tick()
    expect(gh.mock.calls.length).toBe(calls)
  })

  it('keeps watching after a takeover from off fails', async () => {
    origin = await releaseOrigin()
    let offline = false
    const a = lane('one', [], (git) => async (args, input) => {
      if (offline && args[0] === 'ls-remote') throw new Error('git ls-remote failed: offline')
      return git(args, input)
    })
    offline = true
    await expect(a.command('takeover')).rejects.toThrow(/offline/)
    await settle()
    offline = false
    await tick()
    expect(a.status()).toMatchObject({ enabled: true, role: 'active', epoch: 1 })
  })

  it('reads the queue in full again after switching back on or regaining the lease', async () => {
    origin = await releaseOrigin()
    const a = lane('one')
    await a.command('on')
    await a.command('off')
    await a.command('on')
    expect(a.passes()).toHaveLength(2)
    expect(a.passes()[1]).toContain('read the queue in full')
    const b = lane('two')
    await b.command('on')
    await b.command('takeover')
    await tick(LEASE_RENEW_MS)
    expect(a.status()?.role).toBe('standby')
    await b.command('off')
    await tick(LEASE_RENEW_MS)
    expect(a.status()?.role).toBe('active')
    expect(a.passes()).toHaveLength(3)
    expect(a.passes()[2]).toContain('read the queue in full')
  })

  it("keeps a standby lane's runs loud: only the lease holder works quietly", async () => {
    origin = await releaseOrigin()
    const a = lane('one')
    await a.command('on')
    const b = lane('two')
    await b.command('on')
    b.emit('before_agent_start', { messageType: 'custom' })
    expect(b.status()).toMatchObject({ role: 'standby', quiet: false })
  })

  it('waits for the lane to be idle before a pass, and sweeps only with work to move', async () => {
    origin = await releaseOrigin()
    const a = lane('one')
    await a.command('on')
    await tick(SWEEP_MS)
    expect(a.passes()).toHaveLength(1)
    a.ctx.isIdle = () => false
    prs = [
      {
        number: 6,
        headRefOid: 'c'.repeat(40),
        isDraft: true,
        baseRefName: 'main',
        mergeable: 'MERGEABLE',
        labels: [],
        statusCheckRollup: [],
      },
    ]
    await tick()
    expect(a.passes()).toHaveLength(1)
    a.ctx.isIdle = () => true
    a.ctx.hasPendingMessages = () => true
    await tick()
    expect(a.passes()).toHaveLength(1)
    a.ctx.hasPendingMessages = () => false
    await tick()
    expect(a.passes()).toHaveLength(2)
  })

  it('switches off, and hands the lease over, when navigation leaves release mode behind', async () => {
    origin = await releaseOrigin()
    const a = lane('one')
    await a.command('on')
    a.branch.length = 0
    a.emit('session_tree')
    await settle()
    expect(a.status()).toMatchObject({ enabled: false, role: 'off' })
    expect(a.active()).toEqual(['read', 'bash'])
    const { lease } = await readState(origin.git, 'refs/test/check')
    expect(Date.parse(lease!.expires)).toBeLessThanOrEqual(clock)
  })

  it('keeps a problem until a GitHub call succeeds again', async () => {
    origin = await releaseOrigin()
    const a = lane('one')
    await a.command('on')
    gh.mockRejectedValueOnce(new Error('gh pr failed: HTTP 502'))
    await tick()
    a.ctx.isIdle = () => false
    await tick()
    expect(a.status()?.problem).toBe('gh pr failed: HTTP 502')
    a.ctx.isIdle = () => true
    await tick()
    expect(a.status()?.problem).toBeUndefined()
  })
})
