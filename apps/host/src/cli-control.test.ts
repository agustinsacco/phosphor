import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Login from './commands/login'
import type * as Logout from './commands/logout'
import type * as Run from './commands/run'
import type * as Service from './commands/service'
import type * as Status from './commands/status'
import type { CliContext } from './cli-handlers'
import { hostLogDirectory } from './machine/log'
import type { Drainable } from './shutdown'
import { commandLifetime, controlLog, handleControl, handleRun, handleService } from './cli-control'

const m = vi.hoisted(() => ({
  runHost: vi.fn(),
  runService: vi.fn(),
  runLogin: vi.fn(),
  runLogout: vi.fn(),
  runStatus: vi.fn(),
}))
vi.mock('./commands/run', async (original) => ({
  ...(await original<typeof Run>()),
  runHost: m.runHost,
}))
vi.mock('./commands/service', async (original) => ({
  ...(await original<typeof Service>()),
  runService: m.runService,
}))
vi.mock('./commands/login', async (original) => ({
  ...(await original<typeof Login>()),
  runLogin: m.runLogin,
}))
vi.mock('./commands/logout', async (original) => ({
  ...(await original<typeof Logout>()),
  runLogout: m.runLogout,
}))
vi.mock('./commands/status', async (original) => ({
  ...(await original<typeof Status>()),
  runStatus: m.runStatus,
  renderStatus: (report: unknown) => `status ${JSON.stringify(report)}\n`,
}))

const SECRET = 'control-secret-value'
let home: string
let targets: Drainable[]
let detached: number
let context: CliContext
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'phosphor-cli-control-'))
  targets = []
  detached = 0
  context = {
    env: { TOKEN: SECRET, SHORT: 'seven77' },
    platform: 'linux',
    uid: 501,
    home,
    hostname: 'bee1',
    nodeVersion: '22.22.3',
    defaultResourceRoot: '/resources',
    attach: (target) => {
      targets.push(target)
      return () => void detached++
    },
  }
})
afterEach(() => {
  vi.clearAllMocks()
  rmSync(home, { recursive: true, force: true })
})
const io = () => {
  const out = { stdout: '', stderr: '' }
  return {
    out,
    io: {
      stdout: (text: string) => void (out.stdout += text),
      stderr: (text: string) => void (out.stderr += text),
    },
  }
}

describe('commandLifetime', () => {
  it('attaches nothing without a drain failure text', () => {
    const lifetime = commandLifetime(context)
    expect(targets).toEqual([])
    expect(lifetime.signal.aborted).toBe(false)
    lifetime.end()
    expect(detached).toBe(0)
  })

  it('drains by aborting the command and waiting until it ends, then detaches once', async () => {
    const lifetime = commandLifetime(context, 'The service command could not finish.')
    expect(targets).toHaveLength(1)
    const target = targets[0]!
    expect(target.log.hide('anything')).toBe('The service command could not finish.')
    let settled = false
    const drained = target.drain('SIGTERM').then((state) => {
      settled = true
      return state
    })
    expect(lifetime.signal.aborted).toBe(true)
    await Promise.resolve()
    expect(settled).toBe(false)
    lifetime.end()
    expect(await drained).toEqual({ state: 'stopped' })
    expect(detached).toBe(1)
  })

  it("is aborted by the control port's signal without being that signal", () => {
    const controller = new AbortController()
    const lifetime = commandLifetime({ ...context, control: { signal: controller.signal } }, 'x')
    expect(lifetime.signal).not.toBe(controller.signal)
    controller.abort()
    expect(lifetime.signal.aborted).toBe(true)
  })

  it('works when nothing can be attached', () => {
    const lifetime = commandLifetime({ ...context, attach: undefined }, 'x')
    expect(lifetime.signal.aborted).toBe(false)
    lifetime.end()
  })
})

describe('controlLog', () => {
  it('hides every environment value of 8 or more characters', () => {
    const log = controlLog(context)
    log.write('control', `sent ${SECRET} and seven77`, { token: SECRET })
    const text = readFileSync(join(hostLogDirectory(context.env, home), 'phosphor.log'), 'utf8')
    expect(text).not.toContain(SECRET)
    expect(text).toContain('seven77')
    expect(log.hide(`a ${SECRET}`)).not.toContain(SECRET)
  })
})

describe('control handlers', () => {
  it('runs the Host with its supervisor, the control log and no attachment', async () => {
    m.runHost.mockImplementation(async (options: { print(line: string): void }) => {
      options.print('online')
      options.print('done\n')
      return 0
    })
    const { io: cli, out } = io()
    const command = { name: 'run', supervisor: 'launchd', options: {} } as const
    expect(await handleRun(command, cli, context)).toBe(0)
    expect(out.stdout).toBe('online\ndone\n')
    expect(m.runHost.mock.calls[0]![0]).toMatchObject({
      supervisor: 'launchd',
      log: expect.any(Function),
      signal: expect.any(AbortSignal),
      attach: context.attach,
    })
    expect(targets).toEqual([])
  })

  it('runs a service action attached once, and detaches when it throws', async () => {
    m.runService.mockRejectedValue(new Error('launchctl failed'))
    const command = { name: 'service', action: 'logs', options: { follow: true } } as const
    await expect(handleService(command, io().io, context)).rejects.toThrow('launchctl failed')
    expect(m.runService.mock.calls[0]!.slice(1)).toEqual(['logs', true])
    expect(targets).toHaveLength(1)
    expect(targets[0]!.log.hide('x')).toBe('The service command could not finish.')
    expect(detached).toBe(1)
  })

  it('prints status as one JSON line or rendered', async () => {
    m.runStatus.mockResolvedValue({ exitCode: 77, report: { status: 'removed' } })
    const json = io()
    const status = { name: 'status', options: { json: true } } as const
    expect(await handleControl(status, json.io, context)).toBe(77)
    expect(json.out.stdout).toBe('{"status":"removed"}\n')
    const plain = io()
    await handleControl({ name: 'status', options: {} }, plain.io, context)
    expect(plain.out.stdout).toBe('status {"status":"removed"}\n')
    expect(targets.map((target) => target.log.hide('x'))).toEqual([
      'The control command could not finish.',
      'The control command could not finish.',
    ])
    expect(detached).toBe(2)
  })

  it('prints login lines and the outcome, and passes --local to logout', async () => {
    m.runLogin.mockImplementation(async (options: { print(line: string): void }) => {
      options.print('code BCDF-GHJK')
      return { exitCode: 0, message: 'Enrolled.' }
    })
    m.runLogout.mockResolvedValue({ exitCode: 0, message: 'Forgot this machine locally.' })
    const login = io()
    expect(await handleControl({ name: 'login', options: {} }, login.io, context)).toBe(0)
    expect(login.out.stdout).toBe('code BCDF-GHJK\nEnrolled.\n')
    const logout = io()
    await handleControl({ name: 'logout', options: { local: true } }, logout.io, context)
    expect(m.runLogout.mock.calls[0]![1]).toBe(true)
    expect(logout.out.stdout).toBe('Forgot this machine locally.\n')
  })
})
