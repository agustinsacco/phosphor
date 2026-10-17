import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_CLI_PACKAGE,
  checkClaudeCliUpdate,
  checkPackageUpdates,
  detectBinaries,
  parseClaudeAuthStatus,
  resolveBinary,
  runClaudeUpdate,
} from './packages'
import type { JobSender } from './packages'
import type * as Packages from './packages'
import type * as PrintMode from './print-mode'
import { claudeOneShotEnv, claudeProviderSpawnEnv } from './provider-detect'
import { resetShellPathCache } from './shell-env'

// Real print mode unless a test says otherwise, so the proof's delegation is
// observable without spending a real provider turn.
vi.mock('./print-mode', async (importOriginal) => {
  const actual = await importOriginal<typeof PrintMode>()
  return { ...actual, runPrintMode: vi.fn(actual.runPrintMode) }
})

describe('parseClaudeAuthStatus', () => {
  it('parses the Claude Code 2.x logged-in JSON shape', () => {
    // Captured from claude 2.1.219 `claude auth status`.
    const stdout = JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      apiKeySource: '/login managed key',
      email: 'user@example.com',
    })
    expect(parseClaudeAuthStatus(stdout)).toEqual({
      ok: true,
      loggedIn: true,
      method: 'claude.ai',
      email: 'user@example.com',
    })
  })

  it('parses logged-out state and tolerates leading noise', () => {
    const stdout = 'some banner\n{"loggedIn": false}'
    expect(parseClaudeAuthStatus(stdout)).toEqual({
      ok: true,
      loggedIn: false,
      method: undefined,
      email: undefined,
    })
  })

  it('reports non-JSON output as an error, not a crash', () => {
    expect(parseClaudeAuthStatus('command not found').ok).toBe(false)
    expect(parseClaudeAuthStatus('{broken').ok).toBe(false)
    expect(parseClaudeAuthStatus('').ok).toBe(false)
  })
})

describe('checkClaudeCliUpdate', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('asks the registry for the Claude Code package, scope-escaped', async () => {
    const seen: string[] = []
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      seen.push(String(url))
      return new Response(JSON.stringify({ version: '2.1.258' }), { status: 200 })
    }) as typeof fetch

    expect(await checkClaudeCliUpdate()).toBe('2.1.258')
    expect(seen).toEqual(['https://registry.npmjs.org/@anthropic-ai%2fclaude-code/latest'])
    expect(CLAUDE_CLI_PACKAGE).toBe('@anthropic-ai/claude-code')
  })

  it('answers null rather than throwing when the registry is unreachable', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('offline')
    }) as typeof fetch
    expect(await checkClaudeCliUpdate()).toBeNull()
  })

  it('answers null on a non-OK response or a version-less body', async () => {
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 404 })) as typeof fetch
    expect(await checkClaudeCliUpdate()).toBeNull()
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch
    expect(await checkClaudeCliUpdate()).toBeNull()
  })
})

describe('checkPackageUpdates', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('resolves npm entries and skips git and path ones', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ version: '9.9.9' }), { status: 200 }),
    ) as typeof fetch

    const entries = [
      { spec: 'npm:@saccolabs/pi-claude-cli', kind: 'npm' },
      { spec: 'git:github.com/user/repo', kind: 'git' },
    ] as Parameters<typeof checkPackageUpdates>[0]

    expect(await checkPackageUpdates(entries)).toEqual({
      'npm:@saccolabs/pi-claude-cli': '9.9.9',
    })
  })
})

describe('runClaudeUpdate', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'phosphor-claude-update-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** Collect one job's streamed output and exit code. */
  function collect(): { sender: JobSender; done: Promise<{ output: string; code: number }> } {
    let output = ''
    let settle: (value: { output: string; code: number }) => void
    const done = new Promise<{ output: string; code: number }>((resolve) => {
      settle = resolve
    })
    const sender: JobSender = {
      isDestroyed: () => false,
      send: (channel, ...args) => {
        if (channel.startsWith('packages:output:')) output += String(args[0])
        if (channel.startsWith('packages:exit:')) settle({ output, code: Number(args[0]) })
      },
    }
    return { sender, done }
  }

  it("runs the CLI's own `update` subcommand and streams its output", async () => {
    const fake = join(dir, 'claude')
    writeFileSync(fake, '#!/bin/sh\necho "got:$*"\n', { mode: 0o755 })

    const { sender, done } = collect()
    await runClaudeUpdate(sender, fake)

    // `update`, not `npm install -g`: npm does not own a native install.
    expect(await done).toEqual({ output: 'got:update\n', code: 0 })
  })

  it('surfaces a missing binary on the job channels instead of throwing', async () => {
    const { sender, done } = collect()
    // An empty override is falsy, so this takes the PATH-resolution branch;
    // point it at a path that cannot spawn to prove failures still report.
    await runClaudeUpdate(sender, join(dir, 'does-not-exist'))

    const result = await done
    expect(result.code).not.toBe(0)
    expect(result.output.length).toBeGreaterThan(0)
  })
})

/**
 * Job ownership: every package job (pi install/remove/update, the npm pi
 * install, `claude update`, the provider proof) is a process tree Phosphor
 * started, so quit has to be able to stop it, and a job reports its exit once.
 * Module state (the job table, closed admission) is per test: each one loads
 * a fresh copy of the module.
 */
describe('package job ownership', () => {
  let dir: string
  let pidFile: string
  let hangingStub: string
  let answeringStub: string
  let markerFile: string
  let markerStub: string

  interface Sent {
    channel: string
    payload: unknown
  }

  /** A sender that records every message, plus the job's first exit code. */
  function recordJob(): {
    sender: JobSender & { destroyed: boolean }
    sent: Sent[]
    exited: Promise<number>
    output: () => string
    exits: () => unknown[]
  } {
    const sent: Sent[] = []
    let settle: (code: number) => void = () => {}
    const exited = new Promise<number>((resolve) => {
      settle = resolve
    })
    const sender = {
      destroyed: false,
      isDestroyed(): boolean {
        return this.destroyed
      },
      send(channel: string, ...args: unknown[]): void {
        sent.push({ channel, payload: args[0] })
        if (channel.startsWith('packages:exit:')) settle(Number(args[0]))
      },
    }
    return {
      sender,
      sent,
      exited,
      output: () =>
        sent
          .filter(({ channel }) => channel.startsWith('packages:output:'))
          .map(({ payload }) => String(payload))
          .join(''),
      exits: () =>
        sent.filter(({ channel }) => channel.startsWith('packages:exit:')).map((m) => m.payload),
    }
  }

  async function freshModules(): Promise<{
    packages: typeof Packages
    runPrintMode: ReturnType<typeof vi.mocked<typeof PrintMode.runPrintMode>>
  }> {
    vi.resetModules()
    const packages = await import('./packages')
    const printMode = await import('./print-mode')
    // resetModules keeps mocked modules: drop the last test's calls and
    // implementation, back to real print mode.
    const runPrintMode = vi.mocked(printMode.runPrintMode)
    runPrintMode.mockReset()
    return { packages, runPrintMode }
  }

  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  /** Polls on real time, so it works while a test fakes setTimeout. */
  const waitFor = async (check: () => boolean): Promise<boolean> => {
    for (let i = 0; i < 60 && !check(); i++) await delay(50)
    return check()
  }
  const readPids = (): { self: number; child: number } =>
    JSON.parse(readFileSync(pidFile, 'utf8')) as { self: number; child: number }
  const env = (): Record<string, string> => ({ ...(process.env as Record<string, string>) })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'phosphor-package-jobs-'))
    pidFile = join(dir, 'pids.json')
    // Stands in for pi (or npm) mid-install: it has started a child of its
    // own, has printed something, and is not going to finish by itself.
    hangingStub = join(dir, 'hangs.cjs')
    writeFileSync(
      hangingStub,
      [
        "const { spawn } = require('node:child_process')",
        "const { writeFileSync } = require('node:fs')",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
        "process.stdout.write('installing\\n')",
        `writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ self: process.pid, child: child.pid }))`,
        'setInterval(() => {}, 1000)',
      ].join('\n'),
    )
    answeringStub = join(dir, 'answers.cjs')
    writeFileSync(answeringStub, "process.stdout.write('phosphor-provider-ok\\n')\n")
    markerFile = join(dir, 'ran')
    markerStub = join(dir, 'marks.cjs')
    writeFileSync(
      markerStub,
      `require('node:fs').writeFileSync(${JSON.stringify(markerFile)}, '')\n`,
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    if (existsSync(pidFile)) {
      const pids = readPids()
      for (const pid of [pids.self, pids.child]) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // Already gone, which is the point.
        }
      }
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it.skipIf(process.platform === 'win32')(
    'disposal stops a running install and everything it started, reporting once',
    async () => {
      const { packages } = await freshModules()
      const job = recordJob()
      const onExit = vi.fn()
      const { jobId } = await packages.runPackageAction(
        job.sender,
        'install',
        'npm:example',
        'global',
        undefined,
        hangingStub,
        onExit,
      )
      expect(await waitFor(() => existsSync(pidFile))).toBe(true)
      const pids = readPids()

      await packages.disposePackageJobs()

      expect(await waitFor(() => !isAlive(pids.self) && !isAlive(pids.child))).toBe(true)
      expect(job.exits()).toEqual([1])
      expect(onExit.mock.calls).toEqual([[1]])
      expect(job.output()).toContain('installing\n')
      expect(job.output()).toContain('Phosphor is quitting')
      expect(job.sent.every(({ channel }) => channel.endsWith(`:${jobId}`))).toBe(true)
      // The close that follows the kill reports nothing more.
      await delay(200)
      expect(job.exits()).toEqual([1])
      expect(onExit).toHaveBeenCalledTimes(1)
    },
  )

  it('runs the provider proof as bounded print mode with the provider env', async () => {
    const { packages, runPrintMode } = await freshModules()
    runPrintMode.mockImplementation(async (_binary, _args, options) => {
      options.onStdout?.('phosphor-provider-ok\n')
      return { stdout: 'phosphor-provider-ok\n' }
    })
    const job = recordJob()

    const { jobId } = await packages.runClaudeProviderTest(job.sender, answeringStub)
    // Nothing starts until the caller can subscribe with the returned id.
    expect(runPrintMode).not.toHaveBeenCalled()
    expect(job.sent).toEqual([])

    expect(await job.exited).toBe(0)
    expect(job.sent).toEqual([
      { channel: `packages:output:${jobId}`, payload: 'phosphor-provider-ok\n' },
      { channel: `packages:exit:${jobId}`, payload: 0 },
    ])
    expect(runPrintMode).toHaveBeenCalledTimes(1)
    expect(runPrintMode).toHaveBeenCalledWith(
      process.execPath,
      [
        answeringStub,
        '-p',
        '--model',
        'pi-claude-cli/claude-haiku-4-5',
        'Reply with exactly: phosphor-provider-ok',
      ],
      {
        cwd: tmpdir(),
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          ...claudeProviderSpawnEnv(),
          ...claudeOneShotEnv(),
        },
        timeoutMs: 30_000,
        signal: expect.any(AbortSignal),
        onStdout: expect.any(Function),
      },
    )
  })

  it("reports a failed proof with print mode's reason and a non-zero exit", async () => {
    const { packages, runPrintMode } = await freshModules()
    runPrintMode.mockResolvedValue({ stdout: '', error: 'exited 1: not logged in' })
    const job = recordJob()

    await packages.runClaudeProviderTest(job.sender, answeringStub)

    expect(await job.exited).toBe(1)
    expect(job.output()).toBe('exited 1: not logged in\n')
    expect(job.exits()).toEqual([1])
  })

  it('disposal aborts a running provider proof', async () => {
    const { packages, runPrintMode } = await freshModules()
    runPrintMode.mockImplementation(
      (_binary, _args, options) =>
        new Promise<PrintMode.PrintModeResult>((resolve) => {
          options.signal?.addEventListener('abort', () => resolve({ stdout: '', error: 'aborted' }))
        }),
    )
    const job = recordJob()
    await packages.runClaudeProviderTest(job.sender, answeringStub)
    await vi.waitFor(() => expect(runPrintMode).toHaveBeenCalledTimes(1))
    const signal = runPrintMode.mock.calls[0]?.[2].signal

    await packages.disposePackageJobs()

    expect(signal?.aborted).toBe(true)
    expect(job.exits()).toEqual([1])
    expect(job.output()).toContain('aborted')
  })

  it('disposal settles within its bound even when a job never reports', async () => {
    const { packages, runPrintMode } = await freshModules()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    runPrintMode.mockImplementation(() => new Promise<PrintMode.PrintModeResult>(() => {}))
    const job = recordJob()
    await packages.runClaudeProviderTest(job.sender, answeringStub)
    await vi.advanceTimersByTimeAsync(0)
    expect(runPrintMode).toHaveBeenCalledTimes(1)

    let settled = false
    const disposal = packages.disposePackageJobs()
    void disposal.then(() => {
      settled = true
    })
    // Idempotent: a second quit path gets the same settlement.
    expect(packages.disposePackageJobs()).toBe(disposal)
    await vi.advanceTimersByTimeAsync(2_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
  })

  it('refuses every job that arrives after disposal, without spawning', async () => {
    const { packages, runPrintMode } = await freshModules()
    await packages.disposePackageJobs()

    const install = recordJob()
    await packages.runPackageAction(
      install.sender,
      'install',
      'npm:example',
      'global',
      undefined,
      markerStub,
    )
    expect(await install.exited).toBe(127)
    expect(install.output()).toContain('shutting down')

    const proof = recordJob()
    await packages.runClaudeProviderTest(proof.sender, markerStub)
    expect(await proof.exited).toBe(127)

    const direct = recordJob()
    packages.startJob(direct.sender, process.execPath, [markerStub], { env: env() })
    expect(await direct.exited).toBe(127)

    await delay(200)
    expect(runPrintMode).not.toHaveBeenCalled()
    expect(existsSync(markerFile)).toBe(false)
  })

  it('a spawn failure reports one exit and runs onExit once', async () => {
    const { packages } = await freshModules()
    const job = recordJob()
    const onExit = vi.fn()

    packages.startJob(job.sender, join(dir, 'does-not-exist'), [], { env: env(), onExit })

    expect(await job.exited).toBe(127)
    // Node follows a spawn `error` with a `close`; it must not report again.
    await delay(200)
    expect(job.exits()).toEqual([127])
    expect(onExit.mock.calls).toEqual([[127]])
  })

  it('a proof stopped before it starts never spawns', async () => {
    const { packages, runPrintMode } = await freshModules()
    const job = recordJob()
    await packages.runClaudeProviderTest(job.sender, markerStub)

    await packages.disposePackageJobs()

    expect(job.exits()).toEqual([1])
    expect(runPrintMode).toHaveBeenCalledTimes(1)
    expect(runPrintMode.mock.calls[0]?.[2].signal?.aborted).toBe(true)
    await delay(200)
    expect(existsSync(markerFile)).toBe(false)
  })

  it('a closed window hears nothing, and its jobs still end and leave the table', async () => {
    const { packages, runPrintMode } = await freshModules()
    runPrintMode.mockImplementation(async (_binary, _args, options) => {
      options.onStdout?.('phosphor-provider-ok\n')
      return { stdout: 'phosphor-provider-ok\n' }
    })
    const proof = recordJob()
    proof.sender.destroyed = true
    const install = recordJob()
    install.sender.destroyed = true
    const onExit = vi.fn()

    await packages.runClaudeProviderTest(proof.sender, answeringStub)
    packages.startJob(install.sender, process.execPath, [answeringStub], { env: env(), onExit })

    await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(runPrintMode).toHaveBeenCalledTimes(1))
    await delay(50)
    expect(onExit).toHaveBeenCalledWith(0)
    expect(proof.sent).toEqual([])
    expect(install.sent).toEqual([])
    // Both have left the table: disposal has nothing to wait for.
    const settled = await Promise.race([
      packages.disposePackageJobs().then(() => 'settled'),
      delay(1_000).then(() => 'bound'),
    ])
    expect(settled).toBe('settled')
  })

  it.skipIf(process.platform === 'win32')(
    'a job that outlives its 15-minute deadline is stopped with its tree',
    async () => {
      const { packages } = await freshModules()
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const job = recordJob()
      const onExit = vi.fn()

      packages.startJob(job.sender, process.execPath, [hangingStub], { env: env(), onExit })
      expect(await waitFor(() => existsSync(pidFile))).toBe(true)
      const pids = readPids()

      await vi.advanceTimersByTimeAsync(15 * 60_000 - 1)
      expect(job.exits()).toEqual([])
      await vi.advanceTimersByTimeAsync(1)

      expect(job.exits()).toEqual([1])
      expect(onExit.mock.calls).toEqual([[1]])
      expect(job.output()).toContain('15 minutes')
      expect(await waitFor(() => !isAlive(pids.self) && !isAlive(pids.child))).toBe(true)
    },
  )
})

/**
 * `resolveBinary` against a real `/bin/sh`: a fake login shell that reports
 * `loginDir` as its PATH, and a process PATH of `processDir` alone, so
 * nothing installed on the host can answer. Windows has no `where` here, so
 * a fake one on the process PATH answers from `<root>/where/<name>`.
 */
const lookupMachine = { root: '', loginDir: '', processDir: '', loginShell: '' }
const ORIGINAL_PLATFORM = process.platform
const ORIGINAL_LOOKUP_ENV = { PATH: process.env.PATH, SHELL: process.env.SHELL }

function writeExecutable(path: string, text: string): string {
  writeFileSync(path, text)
  chmodSync(path, 0o755)
  return path
}

/** What the fake login shell prints as its PATH; '' leaves it unknown. */
function reportLoginPath(path: string): void {
  const ran = join(lookupMachine.root, 'login-shell-ran')
  writeExecutable(lookupMachine.loginShell, `#!/bin/sh\n: > '${ran}'\nprintf %s '${path}'\n`)
  resetShellPathCache()
}

function setUpLookupMachine(): void {
  const root = mkdtempSync(join(tmpdir(), 'phosphor-resolve-binary-'))
  Object.assign(lookupMachine, {
    root,
    loginDir: join(root, 'login'),
    processDir: join(root, 'process'),
    loginShell: join(root, 'login-shell'),
  })
  mkdirSync(lookupMachine.loginDir)
  mkdirSync(lookupMachine.processDir)
  mkdirSync(join(root, 'where'))
  writeExecutable(
    join(lookupMachine.processDir, 'where'),
    `#!/bin/sh\nanswer='${root}/where/'"$1"\n[ -f "$answer" ] && exec /bin/cat "$answer"\nexit 1\n`,
  )
  process.env.PATH = lookupMachine.processDir
  process.env.SHELL = lookupMachine.loginShell
  reportLoginPath(lookupMachine.loginDir)
}

function tearDownLookupMachine(): void {
  Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true })
  for (const [name, value] of Object.entries(ORIGINAL_LOOKUP_ENV)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  resetShellPathCache()
  rmSync(lookupMachine.root, { recursive: true, force: true })
}

/** An executable named `name` in `dir`, as `command -v` would print it. */
function installBinary(dir: string, name: string): string {
  return writeExecutable(join(dir, name), '#!/bin/sh\n')
}

// Real `/bin/sh`, and a `where` that is an sh script: POSIX hosts only.
describe.skipIf(process.platform === 'win32')('resolveBinary', () => {
  beforeEach(setUpLookupMachine)
  afterEach(tearDownLookupMachine)

  it('takes a binary from the login-shell PATH first', async () => {
    const login = installBinary(lookupMachine.loginDir, 'claude')
    installBinary(lookupMachine.processDir, 'claude')

    expect(await resolveBinary('claude')).toBe(login)
  })

  it('falls back to the process PATH', async () => {
    const fallback = installBinary(lookupMachine.processDir, 'claude')

    expect(await resolveBinary('claude')).toBe(fallback)
  })

  it('asks only the process PATH when the login-shell PATH is unknown', async () => {
    reportLoginPath('')
    installBinary(lookupMachine.loginDir, 'claude')
    const fallback = installBinary(lookupMachine.processDir, 'claude')

    expect(await resolveBinary('claude')).toBe(fallback)
  })

  it('answers null when neither PATH has the binary', async () => {
    expect(await resolveBinary('claude')).toBeNull()
  })

  it('resolves the constant names its callers ask for', async () => {
    for (const name of ['claude', 'npm', 'uv', 'pipx', 'headroom']) {
      const path = installBinary(lookupMachine.loginDir, name)
      expect(await resolveBinary(name)).toBe(path)
    }
    expect(await detectBinaries()).toEqual({ claude: true })
    rmSync(join(lookupMachine.loginDir, 'claude'))
    expect(await detectBinaries()).toEqual({ claude: false })
  })

  it('on Windows, takes the `where` match a spawn can use, not a node launch', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const npmDir = 'C:\\Users\\dev\\AppData\\Roaming\\npm'
    const where = (name: string, lines: string[]): void =>
      writeFileSync(join(lookupMachine.root, 'where', name), `${lines.join('\r\n')}\r\n`)
    rmSync(join(lookupMachine.root, 'login-shell-ran'), { force: true })

    // npm's three shims, sh script first: the .cmd itself, not node.exe + entry.
    where('claude', [`${npmDir}\\claude`, `${npmDir}\\claude.cmd`, `${npmDir}\\claude.ps1`])
    expect(await resolveBinary('claude')).toBe(`${npmDir}\\claude.cmd`)
    where('uv', [`${npmDir}\\uv.cmd`, 'C:\\Tools\\uv.exe'])
    expect(await resolveBinary('uv')).toBe('C:\\Tools\\uv.exe')
    // `where` exits 1 for a name it cannot find.
    expect(await resolveBinary('pipx')).toBeNull()
    // No login shell on Windows.
    expect(existsSync(join(lookupMachine.root, 'login-shell-ran'))).toBe(false)
  })
})
