import { homedir, hostname } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Cli from './cli'
import type * as Probe from './machine/probe'
import type * as ShutdownModule from './shutdown'

// main.ts is the built entry: importing it wires the real process to the
// shutdown and runs the CLI. Every port it touches is replaced here, so an
// import neither exits the runner nor leaves a listener on its process.
const ports = vi.hoisted(() => ({
  runCli: vi.fn<typeof Cli.runCli>(),
  createShutdown: vi.fn<typeof ShutdownModule.createShutdown>(),
  flushStreams: vi.fn<typeof ShutdownModule.flushStreams>(),
  stopProbes: vi.fn<typeof Probe.stopProbes>(),
}))
vi.mock('./cli', () => ({ runCli: ports.runCli }))
vi.mock('./machine/probe', () => ({ stopProbes: ports.stopProbes }))
vi.mock('./shutdown', async (importOriginal) => ({
  ...(await importOriginal<typeof ShutdownModule>()),
  createShutdown: ports.createShutdown,
  flushStreams: ports.flushStreams,
}))

const ROUTED = ['SIGHUP', 'SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']
type Listener = (...args: unknown[]) => unknown

let calls: string[]
let listeners: Map<string, Listener[]>
let shutdownIo: ShutdownModule.ShutdownIo[]
let flush: (done: () => void) => void
let shutdown: {
  attach: ReturnType<typeof vi.fn<ShutdownModule.Shutdown['attach']>>
  signal: ReturnType<typeof vi.fn<ShutdownModule.Shutdown['signal']>>
  finish: ReturnType<typeof vi.fn<ShutdownModule.Shutdown['finish']>>
  fatal: ReturnType<typeof vi.fn<ShutdownModule.Shutdown['fatal']>>
}
const restores: (() => void)[] = []

/** Replace `key` on `target` until the test ends, whether or not it is an own property. */
function override<T extends object>(target: T, key: PropertyKey, value: unknown) {
  const saved = Object.getOwnPropertyDescriptor(target, key)
  Object.defineProperty(target, key, { value, configurable: true, writable: true })
  restores.push(() => {
    if (saved) Object.defineProperty(target, key, saved)
    else Reflect.deleteProperty(target, key)
  })
}

beforeEach(() => {
  vi.resetModules()
  calls = []
  listeners = new Map()
  shutdownIo = []
  flush = vi.fn()
  shutdown = {
    attach: vi.fn(() => () => {}),
    signal: vi.fn(async () => {}),
    finish: vi.fn((code: number) => void calls.push(`finish ${code}`)),
    fatal: vi.fn(async () => {}),
  }
  ports.createShutdown.mockReset().mockImplementation((io) => {
    calls.push('createShutdown')
    shutdownIo.push(io)
    return shutdown
  })
  ports.flushStreams.mockReset().mockReturnValue(flush)
  ports.stopProbes.mockReset()
  ports.runCli.mockReset().mockImplementation(async () => {
    calls.push('runCli')
    return 0
  })
  const realOn = process.on.bind(process)
  vi.spyOn(process, 'on').mockImplementation((event, listener) => {
    if (typeof event !== 'string' || !ROUTED.includes(event)) return realOn(event, listener)
    calls.push(`on ${event}`)
    listeners.set(event, [...(listeners.get(event) ?? []), listener])
    return process
  })
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit(${String(code)}) reached the test runner`)
  })
  override(process, 'argv', [process.execPath, '/opt/phosphor/phosphor.mjs', 'doctor', '--json'])
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const restore of restores.splice(0).reverse()) restore()
})

/** Import the entry with stdin and stdout set as a terminal or not. */
async function importMain(tty: { stdin?: boolean; stdout?: boolean } = {}) {
  override(process.stdin, 'isTTY', tty.stdin)
  override(process.stdout, 'isTTY', tty.stdout)
  await import('./main')
}

function cliCall() {
  expect(ports.runCli).toHaveBeenCalledOnce()
  const [argv, io, context] = ports.runCli.mock.calls[0]!
  return { argv, io, context }
}

describe('the Host entry wiring', () => {
  it('attaches one shutdown and registers its routes before running the CLI', async () => {
    await importMain()
    expect(ports.createShutdown).toHaveBeenCalledOnce()
    expect(calls).toEqual([
      'createShutdown',
      'on SIGHUP',
      'on SIGINT',
      'on SIGTERM',
      'on uncaughtException',
      'on unhandledRejection',
      'runCli',
      'finish 0',
    ])
    for (const event of ROUTED) expect(listeners.get(event)).toHaveLength(1)
    expect(cliCall().context.attach).toBe(shutdown.attach)
  })

  it.each(['SIGHUP', 'SIGINT', 'SIGTERM'] as const)(
    'routes %s to the shutdown signal',
    async (name) => {
      await importMain()
      const [listener] = listeners.get(name)!
      expect(listener!()).toBeUndefined()
      expect(shutdown.signal).toHaveBeenCalledExactlyOnceWith(name)
      expect(shutdown.fatal).not.toHaveBeenCalled()
    },
  )

  it.each(['uncaughtException', 'unhandledRejection'])(
    'routes %s to the fatal shutdown with its error',
    async (event) => {
      await importMain()
      const error = new Error(event)
      const [listener] = listeners.get(event)!
      expect(listener!(error)).toBeUndefined()
      expect(shutdown.fatal).toHaveBeenCalledExactlyOnceWith(error)
      expect(shutdown.signal).not.toHaveBeenCalled()
    },
  )

  it('leaves no listener on the real process', async () => {
    const before = ROUTED.map((event) => process.listenerCount(event))
    await importMain()
    expect(ROUTED.map((event) => process.listenerCount(event))).toEqual(before)
  })
})

describe('the Host entry shutdown ports', () => {
  it('exits, writes stderr, stops probes and flushes both streams through the process', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    await importMain()
    expect(shutdownIo).toHaveLength(1)
    const io = shutdownIo[0]!
    expect(ports.flushStreams).toHaveBeenCalledOnce()
    const [streams] = ports.flushStreams.mock.calls[0]!
    expect(streams).toHaveLength(2)
    expect(streams[0]).toBe(process.stdout)
    expect(streams[1]).toBe(process.stderr)
    expect(io.flush).toBe(flush)
    expect(io.stopProbes).toBe(ports.stopProbes)
    io.stderr('fatal: boom\n')
    expect(stderr).toHaveBeenCalledExactlyOnceWith('fatal: boom\n')
    expect(() => io.exit(70)).toThrow('process.exit(70) reached the test runner')
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(70)
  })
})

describe('the Host entry CLI call', () => {
  it('passes the arguments after the script and writes through the process streams', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    await importMain()
    const { argv, io } = cliCall()
    expect(argv).toEqual(['doctor', '--json'])
    io.stdout('out\n')
    io.stderr('err\n')
    expect(stdout).toHaveBeenCalledExactlyOnceWith('out\n')
    expect(stderr).toHaveBeenCalledExactlyOnceWith('err\n')
  })

  it('describes the machine and roots resources beside the entry module', async () => {
    override(process, 'getuid', () => 501)
    await importMain({ stdin: true, stdout: true })
    const { rich: _rich, ...context } = cliCall().context
    expect(context).toEqual({
      env: process.env,
      platform: process.platform,
      uid: 501,
      home: homedir(),
      hostname: hostname(),
      nodeVersion: process.versions.node,
      defaultResourceRoot: import.meta.dirname,
      attach: shutdown.attach,
      terminal: true,
    })
    expect(cliCall().context.env).toBe(process.env)
  })

  it.each([
    [{}, true],
    [{ CI: 'true' }, false],
    [{ PHOSPHOR_PLAIN: '1' }, false],
  ])('on a terminal with %o, draws a screen: %s', async (env, drawn) => {
    for (const name of ['CI', 'GITHUB_ACTIONS', 'PHOSPHOR_PLAIN', 'TERM'])
      vi.stubEnv(name, undefined)
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
    await importMain({ stdin: true, stdout: true })
    const { rich } = cliCall().context
    if (!drawn) return expect(rich).toBeUndefined()
    expect(rich).toMatchObject({ input: process.stdin, output: process.stdout, animate: true })
  })

  it('draws no screen when either end is not a terminal', async () => {
    vi.stubEnv('CI', undefined)
    vi.stubEnv('GITHUB_ACTIONS', undefined)
    await importMain({ stdin: true, stdout: false })
    expect(cliCall().context.rich).toBeUndefined()
  })

  it('passes no uid where the platform has no getuid', async () => {
    override(process, 'getuid', undefined)
    await importMain()
    expect(cliCall().context.uid).toBeUndefined()
  })

  it.each([
    [{ stdin: true, stdout: true }, true],
    [{ stdin: true, stdout: undefined }, false],
    [{ stdin: undefined, stdout: true }, false],
    [{ stdin: false, stdout: false }, false],
    [{ stdin: undefined, stdout: undefined }, false],
  ])('with %o, terminal is %s', async (tty, terminal) => {
    await importMain(tty)
    expect(cliCall().context.terminal).toBe(terminal)
  })
})

describe('the Host entry exit handoff', () => {
  it('hands the command code to the shutdown only once the CLI ends', async () => {
    let end!: (code: number) => void
    ports.runCli.mockImplementation(() => {
      calls.push('runCli')
      return new Promise<number>((resolve) => (end = resolve))
    })
    const loaded = importMain()
    await vi.waitFor(() => expect(ports.runCli).toHaveBeenCalledOnce())
    await Promise.resolve()
    expect(shutdown.finish).not.toHaveBeenCalled()
    end(78)
    await loaded
    expect(shutdown.finish).toHaveBeenCalledExactlyOnceWith(78)
    expect(calls.slice(-2)).toEqual(['runCli', 'finish 78'])
    expect(process.exit).not.toHaveBeenCalled()
  })
})
