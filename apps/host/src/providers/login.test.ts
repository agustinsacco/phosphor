import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { fakeMachine } from '../__fixtures__/machine'
import type { HostPtyModule } from '../terminals/native'
import { createTerminals } from '../terminals/service'
import type { TerminalFrame } from '@phosphor/shared/host-protocol-terminals'
import { PROVIDER_LOGIN_LIMITS } from '@phosphor/shared/host-protocol-providers'
import { createProviderLogins } from './login'
import { createLaneAdapter } from '../api/lanes'
import { createLaneStreams, createLanesTopic } from '../lanes/stream'
import { createLoopbackPair } from '@phosphor/shared/host-protocol-testing'
import { type LoginContext, runProviderLogin } from '../commands/provider-login'

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close())
  vi.unstubAllEnvs()
  vi.useRealTimers()
})
const context: Omit<LoginContext, 'provider' | 'progress' | 'run'> = {
  configPath: '/nonexistent',
  env: {},
  platform: 'linux',
  uid: process.getuid?.(),
  home: '/nonexistent',
  hostname: 'test',
  nodeVersion: '22.22.3',
  defaultResourceRoot: '/nonexistent',
}
const fakeLogin: typeof runProviderLogin = async (ctx) => {
  await ctx.run?.('/host/pi', ['--no-session'], {
    cwd: '/host/empty',
    env: { TERM: 'xterm-256color' },
  })
  return { exitCode: 0, problem: 'test' }
}
function setup(login: typeof runProviderLogin = fakeLogin, ctx = context) {
  const data: ((text: string) => void)[] = []
  const exits: (() => void)[] = []
  const ptys: {
    write: ReturnType<typeof vi.fn>
    kill: ReturnType<typeof vi.fn>
    resize: ReturnType<typeof vi.fn>
  }[] = []
  const spawn = vi.fn<HostPtyModule['spawn']>(() => {
    const pty = {
      write: vi.fn(),
      kill: vi.fn(),
      resize: vi.fn(),
      onData(cb: (text: string) => void) {
        data.push(cb)
        return { dispose() {} }
      },
      onExit(cb: (event: { exitCode: number }) => void) {
        exits.push(() => cb({ exitCode: 0 }))
        return { dispose() {} }
      },
    }
    ptys.push(pty)
    return pty
  })
  const log = vi.fn(),
    save = vi.fn()
  const terminals = createTerminals({
    native: { spawn },
    context: {
      store: { getLane: () => null, listRepositories: () => [] },
      env: {},
      home: '/',
      log,
    },
    env: {},
    epoch: 'a'.repeat(16),
    load: () => [],
    save,
  })
  cleanups.push(terminals.close)
  const service = createProviderLogins(ctx, terminals, login)
  const owner = randomUUID()
  const start = (provider = 'xai', authorized = () => true) =>
    service.execute({ type: 'provider.login', provider }, owner, authorized)
  return { service, terminals, spawn, data, exits, ptys, log, save, start, owner }
}
it('uses the CLI allowlist and fixed program options, and deletes its empty cwd after exit', async () => {
  const machine = fakeMachine()
  cleanups.push(machine.cleanup)
  vi.stubEnv('PI_CODING_AGENT_DIR', machine.agentDir)
  const f = setup(runProviderLogin, {
    ...context,
    configPath: machine.configPath,
    home: machine.home,
    env: { ...machine.hostEnv, TERM: 'xterm-256color' },
    probeTimeoutMs: 5000,
  })
  await expect(f.start('not-a-host-provider')).rejects.toThrow('unavailable')
  expect(f.spawn).not.toHaveBeenCalled()
  const result = await f.start()
  expect(result.terminalId).toMatch(/^[a-f0-9-]{36}$/)
  expect(f.spawn).toHaveBeenCalledWith(
    process.execPath,
    [machine.cli, '--no-session', '--no-approve', '--no-extensions'],
    expect.objectContaining({ env: expect.objectContaining({ TERM: 'xterm-256color' }) }),
  )
  const settings = f.spawn.mock.calls[0]?.[2]
  expect(settings).toBeDefined()
  // The spawn spy is typed by the actual native port below, not by caller input.
  f.exits[0]?.()
  await vi.waitFor(() => {
    if (
      !settings ||
      typeof settings !== 'object' ||
      !('cwd' in settings) ||
      typeof settings.cwd !== 'string'
    )
      throw new Error('missing cwd')
    expect(existsSync(settings.cwd)).toBe(false)
  })
})
it('checks the live capabilities before admission and again after CLI inspection', async () => {
  let allowed = false
  const f = setup(async (ctx) => {
    allowed = false
    return fakeLogin(ctx)
  })
  await expect(f.start('xai', () => allowed)).rejects.toThrow('forbidden')
  allowed = true
  await expect(f.start('xai', () => allowed)).rejects.toThrow('unavailable')
  expect(f.spawn).not.toHaveBeenCalled()
})
it('bounds provider and Host occupancy, including pending inspection', async () => {
  const f = setup()
  await f.start('xai')
  await expect(f.start('xai')).rejects.toThrow('too-many-requests')
  await f.start('claude')
  await expect(f.start('openai-codex')).rejects.toThrow('too-many-requests')
  expect(f.spawn).toHaveBeenCalledTimes(2)
})
it('restricts subscription, input, resize and kill to the creating client', async () => {
  const f = setup()
  const { terminalId } = await f.start()
  const other = randomUUID()
  const sub = { type: 'subscribe' as const, topic: 'terminal' as const, id: 's', terminalId }
  expect(f.terminals.subscribe(sub, vi.fn(), other)).toBeNull()
  expect(f.terminals.subscribe(sub, vi.fn())).toBeNull()
  const input = { type: 'terminal.input' as const, terminalId, seq: 1, data: 'private-input' }
  expect(f.terminals.input(other, input)).toBe(false)
  for (const op of [
    { type: 'terminal.kill' as const, terminalId },
    { type: 'terminal.resize' as const, terminalId, cols: 90, rows: 30 },
  ])
    expect(() => f.terminals.machineOp(other, op)).toThrow('forbidden')
  expect(f.terminals.input(f.owner, input)).toBe(true)
  expect(f.terminals.input(f.owner, input)).toBe(false)
  expect(f.ptys[0]?.write).toHaveBeenCalledOnce()
  f.terminals.machineOp(f.owner, { type: 'terminal.resize', terminalId, cols: 90, rows: 30 })
  expect(f.ptys[0]?.resize).toHaveBeenCalledWith(90, 30)
})
it('reuses input byte/rate limits and bounded output without logging or persisting content', async () => {
  const f = setup()
  const { terminalId } = await f.start()
  const frames: TerminalFrame[] = []
  f.terminals.subscribe(
    { type: 'subscribe', topic: 'terminal', id: 's', terminalId },
    (frame) => frames.push(frame),
    f.owner,
  )
  const input = (seq: number, data: string) =>
    f.terminals.input(f.owner, { type: 'terminal.input', terminalId, seq, data })
  expect(input(1, 'x'.repeat(4097))).toBe(false)
  for (let seq = 1; seq <= 16; seq++) expect(input(seq, 'x'.repeat(4096))).toBe(true)
  expect(input(17, 'x')).toBe(false)
  f.data[0]?.('private-output' + 'a'.repeat(300000))
  const reset: TerminalFrame[] = []
  f.terminals.subscribe(
    { type: 'subscribe', topic: 'terminal', id: 'r', terminalId },
    (frame) => reset.push(frame),
    f.owner,
  )
  expect(reset[0]?.type).toBe('terminal.reset')
  expect(JSON.stringify(reset).length).toBeLessThan(263000)
  expect(f.log).not.toHaveBeenCalled()
  expect(f.save.mock.calls.flat()).toEqual([[]])
  f.exits[0]?.()
  expect(frames.at(-1)?.type).toBe('terminal.exit')
  expect(f.ptys[0]?.kill).toHaveBeenCalledOnce()
  expect(
    f.terminals.subscribe(
      { type: 'subscribe', topic: 'terminal', id: 'gone', terminalId },
      vi.fn(),
      f.owner,
    ),
  ).toBeNull()
})
it('cleans up after ten disconnected minutes, allows same-client reattach, and kills on revocation/shutdown', async () => {
  vi.useFakeTimers()
  const f = setup()
  const { terminalId } = await f.start()
  f.terminals.presence(f.owner, false)
  await vi.advanceTimersByTimeAsync(PROVIDER_LOGIN_LIMITS.disconnectMs - 1000)
  expect(f.ptys[0]?.kill).not.toHaveBeenCalled()
  f.terminals.presence(f.owner, true)
  await vi.advanceTimersByTimeAsync(2000)
  expect(f.ptys[0]?.kill).not.toHaveBeenCalled()
  f.terminals.presence(f.owner, false)
  await vi.advanceTimersByTimeAsync(PROVIDER_LOGIN_LIMITS.disconnectMs)
  expect(f.ptys[0]?.kill).toHaveBeenCalledOnce()
  expect(
    f.terminals.input(f.owner, { type: 'terminal.input', terminalId, seq: 1, data: 'x' }),
  ).toBe(false)
  await f.start('claude')
  f.terminals.presence(f.owner, true, true)
  expect(f.ptys[1]?.kill).toHaveBeenCalledOnce()
  await f.start('openai-codex')
  f.terminals.close()
  expect(f.ptys[2]?.kill).toHaveBeenCalledOnce()
})

it('reports an exit that beats first subscribe without retaining private output', async () => {
  const f = setup()
  const { terminalId } = await f.start()
  f.data[0]?.('private-output')
  f.exits[0]?.()
  const completed: TerminalFrame[] = []
  f.terminals.subscribe(
    { type: 'subscribe', topic: 'terminal', id: 'done', terminalId },
    (frame) => completed.push(frame),
    f.owner,
  )
  expect(completed).toEqual([
    expect.objectContaining({ type: 'terminal.reset', status: 'exited', data: '' }),
    expect.objectContaining({ type: 'terminal.exit', exitCode: 0 }),
  ])
  expect(JSON.stringify(completed)).not.toContain('private-output')
  expect(
    f.terminals.subscribe(
      { type: 'subscribe', topic: 'terminal', id: 'gone', terminalId },
      vi.fn(),
      f.owner,
    ),
  ).toBeNull()
})

it('expires content-free exit tombstones after ten minutes even when the owner reconnects', async () => {
  vi.useFakeTimers()
  const f = setup()
  const { terminalId } = await f.start()
  f.exits[0]?.()
  await vi.advanceTimersByTimeAsync(PROVIDER_LOGIN_LIMITS.disconnectMs - 1000)
  f.terminals.presence(f.owner, true)
  await vi.advanceTimersByTimeAsync(1000)
  expect(
    f.terminals.subscribe(
      { type: 'subscribe', topic: 'terminal', id: 'expired', terminalId },
      vi.fn(),
      f.owner,
    ),
  ).toBeNull()
})

it('excludes exit tombstones from login occupancy and gives indistinguishable non-owner refusals', async () => {
  const f = setup()
  const { terminalId } = await f.start()
  f.exits[0]?.()
  await vi.waitFor(async () => {
    await f.start('xai')
  })
  await f.start('claude')
  await expect(f.start('openai-codex')).rejects.toThrow('too-many-requests')
  const other = randomUUID()
  for (const id of [terminalId, randomUUID()]) {
    expect(
      f.terminals.subscribe(
        { type: 'subscribe', topic: 'terminal', id: 'other', terminalId: id },
        vi.fn(),
        other,
      ),
    ).toBeNull()
    expect(
      f.terminals.input(other, { type: 'terminal.input', terminalId: id, seq: 1, data: 'x' }),
    ).toBe(false)
    for (const op of [
      { type: 'terminal.kill' as const, terminalId: id },
      { type: 'terminal.resize' as const, terminalId: id, cols: 90, rows: 30 },
    ])
      expect(() => f.terminals.machineOp(other, op)).toThrow(new Error('forbidden'))
  }
})

it('bounds unwatched completion tombstones by the overall Host terminal limit', async () => {
  const f = setup()
  for (let i = 0; i < 32; i++) {
    await f.start()
    f.exits[i]?.()
    // The CLI runner settles before the provider occupancy reservation releases.
    for (let turn = 0; turn < 8; turn++) await Promise.resolve()
  }
  await expect(f.start()).rejects.toThrow('unavailable')
  expect(f.spawn).toHaveBeenCalledTimes(32)
})

function adapterFor(f: ReturnType<typeof setup>) {
  const epoch = 'a'.repeat(16)
  const caps = ['terminal', 'sessions.control'] as const
  const adapter = createLaneAdapter({
    epoch,
    capabilities: caps,
    terminals: f.terminals,
    commands: { submit: vi.fn(), status: vi.fn(), capabilityFor: () => caps },
    streams: createLaneStreams({ epoch, snapshot: () => null }),
    lanesTopic: createLanesTopic({ epoch, list: () => ({ lanes: [], repositories: [] }) }),
    calls: { call: vi.fn(), capabilityFor: () => null },
    controllerPresence() {},
  })
  const connect = () =>
    adapter.handler({
      connectionId: randomUUID(),
      client: { id: f.owner, label: 'Owner' },
      caps,
      socket: createLoopbackPair().server,
    })
  return { connect }
}
it.each(['terminal', 'sessions.control'] as const)(
  'adapter renewal without %s kills login PTY',
  async (lost) => {
    const f = setup()
    const { connect } = adapterFor(f)
    const handler = connect()
    await f.start()
    handler.renew(lost === 'terminal' ? ['sessions.control'] : ['terminal'])
    expect(f.ptys[0]?.kill).toHaveBeenCalledOnce()
    handler.close()
  },
)
it.each([false, true])('last socket starts login expiry clock, reconnect=%s', async (reconnect) => {
  vi.useFakeTimers()
  const f = setup()
  const { connect } = adapterFor(f)
  const first = connect(),
    second = connect()
  await f.start()
  first.close()
  await vi.advanceTimersByTimeAsync(600000)
  expect(f.ptys[0]?.kill).not.toHaveBeenCalled()
  second.close()
  await vi.advanceTimersByTimeAsync(599000)
  expect(f.ptys[0]?.kill).not.toHaveBeenCalled()
  const next = reconnect ? connect() : null
  await vi.advanceTimersByTimeAsync(2000)
  expect(f.ptys[0]?.kill).toHaveBeenCalledTimes(reconnect ? 0 : 1)
  next?.close()
})
