import type * as ChildProcess from 'node:child_process'
import type { ExecFileOptions } from 'node:child_process'
import type * as Fs from 'node:fs'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MIN_PI_VERSION } from '@shared/models'

/**
 * How `checkPiHealth` finds pi, through its public entry. POSIX lookups run
 * the real `/bin/sh` over real directories, so these pin what is found, not
 * how the lookup is spelled. Windows has no `where` here: it is answered by
 * the fake below, and the shim and node.exe exist only in `windowsDisk`.
 */

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void
type ExecFileCall = (
  file: string,
  args: string[],
  options: ExecFileOptions,
  callback: ExecFileCallback,
) => void

const lookup = vi.hoisted(() => ({
  execFile: vi.fn<ExecFileCall>(),
  realExecFile: null as ExecFileCall | null,
  loginShellPath: vi.fn<() => Promise<string | null>>(),
  /** Windows paths that exist; a null value exists but cannot be read. */
  windowsDisk: new Map<string, string | null>(),
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>()
  lookup.realExecFile = (file, args, options, callback) => {
    actual.execFile(file, args, { ...options, encoding: 'utf8' }, callback)
  }
  const execFile = Object.assign(
    (file: string, args: string[], options: ExecFileOptions, callback: ExecFileCallback) =>
      lookup.execFile(file, args, options, callback),
    {
      // What util.promisify looks for, so `{ stdout, stderr }` resolves as it
      // does for the real execFile.
      [Symbol.for('nodejs.util.promisify.custom')]: (
        file: string,
        args: string[],
        options: ExecFileOptions,
      ): Promise<{ stdout: string; stderr: string }> =>
        new Promise((resolve, reject) => {
          lookup.execFile(file, args, options, (error, stdout, stderr) =>
            error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }),
          )
        }),
    },
  )
  return { ...actual, execFile }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>()
  const existsSync = (path: Fs.PathLike): boolean =>
    lookup.windowsDisk.has(String(path)) || actual.existsSync(path)
  const readFileSync = ((path: Fs.PathOrFileDescriptor, options?: unknown) => {
    if (typeof path === 'string' && lookup.windowsDisk.has(path)) {
      const text = lookup.windowsDisk.get(path)
      if (text === null || text === undefined) throw new Error(`EACCES: ${path}`)
      return text
    }
    return actual.readFileSync(path, options as Parameters<typeof actual.readFileSync>[1])
  }) as typeof actual.readFileSync
  return { ...actual, existsSync, readFileSync }
})

vi.mock('./shell-env', () => ({
  getLoginShellPath: () => lookup.loginShellPath(),
  piProcessEnv: async () => ({ PATH: '/usr/bin:/bin' }),
}))

import { checkPiHealth } from './health'

const ORIGINAL_PLATFORM = process.platform
const ORIGINAL_PATH = process.env.PATH

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

/** Calls the fake saw, as [file, args, options]. */
function calls(file: string): Array<[string, string[], ExecFileOptions]> {
  return lookup.execFile.mock.calls
    .filter(([called]) => called === file)
    .map(([called, args, options]) => [called, args, options])
}

// Real `/bin/sh`: POSIX hosts only. The Windows block fakes everything it runs.
describe.skipIf(process.platform === 'win32')('checkPiHealth lookup on POSIX', () => {
  let root: string
  let loginDir: string
  let processDir: string

  /** An executable `pi` that answers `--version` like pi does. */
  function installPi(dir: string): string {
    const pi = join(dir, 'pi')
    writeFileSync(pi, `#!/bin/sh\necho "${MIN_PI_VERSION}"\n`)
    chmodSync(pi, 0o755)
    return pi
  }

  beforeEach(() => {
    setPlatform('darwin')
    root = mkdtempSync(join(tmpdir(), 'phosphor-health-lookup-'))
    loginDir = join(root, 'login')
    processDir = join(root, 'process')
    mkdirSync(loginDir)
    mkdirSync(processDir)
    lookup.execFile.mockReset()
    lookup.execFile.mockImplementation((file, args, options, callback) =>
      lookup.realExecFile?.(file, args, options, callback),
    )
    lookup.loginShellPath.mockReset()
    lookup.loginShellPath.mockResolvedValue(loginDir)
    process.env.PATH = processDir
  })

  afterEach(() => {
    setPlatform(ORIGINAL_PLATFORM)
    process.env.PATH = ORIGINAL_PATH
    rmSync(root, { recursive: true, force: true })
  })

  it('takes pi from the login-shell PATH first', async () => {
    const loginPi = installPi(loginDir)
    installPi(processDir)

    expect(await checkPiHealth()).toEqual({
      ok: true,
      binaryPath: loginPi,
      version: MIN_PI_VERSION,
      minVersion: MIN_PI_VERSION,
    })
    const lookups = calls('/bin/sh')
    expect(lookups).toHaveLength(1)
    expect(lookups[0]?.[2]).toEqual({ timeout: 15_000, env: { ...process.env, PATH: loginDir } })
  })

  it('falls back to the process PATH when the login-shell PATH has no pi', async () => {
    const processPi = installPi(processDir)

    expect(await checkPiHealth()).toEqual({
      ok: true,
      binaryPath: processPi,
      version: MIN_PI_VERSION,
      minVersion: MIN_PI_VERSION,
    })
    const lookups = calls('/bin/sh')
    expect(lookups).toHaveLength(2)
    expect(lookups[1]?.[2].timeout).toBe(15_000)
    expect(lookups[1]?.[2].env?.PATH ?? process.env.PATH).toBe(processDir)
  })

  it('falls back to the process PATH when the login-shell lookup fails', async () => {
    installPi(loginDir)
    const processPi = installPi(processDir)
    lookup.execFile.mockImplementationOnce((_file, _args, _options, callback) =>
      callback(new Error('Command failed: timed out'), '', ''),
    )

    const health = await checkPiHealth()

    expect(health.ok).toBe(true)
    expect(health.binaryPath).toBe(processPi)
    expect(calls('/bin/sh')).toHaveLength(2)
  })

  it('asks only the process PATH when the login-shell PATH is unknown', async () => {
    lookup.loginShellPath.mockResolvedValue(null)
    installPi(loginDir)
    const processPi = installPi(processDir)

    expect((await checkPiHealth()).binaryPath).toBe(processPi)
    expect(calls('/bin/sh')).toHaveLength(1)
  })

  it('keeps the last line of the lookup output, trimmed', async () => {
    const processPi = installPi(processDir)
    lookup.execFile.mockImplementationOnce((_file, _args, _options, callback) =>
      callback(null, `rc chatter\n  ${processPi}  \n`, ''),
    )

    expect((await checkPiHealth()).binaryPath).toBe(processPi)
  })

  it('reports not-found, without running anything, when neither PATH has pi', async () => {
    expect(await checkPiHealth()).toEqual({
      ok: false,
      minVersion: MIN_PI_VERSION,
      reason: 'not-found',
      message:
        'The pi coding agent was not found on your PATH. Install it with: ' +
        'npm install -g @earendil-works/pi-coding-agent',
    })
    expect(lookup.execFile.mock.calls.map(([file]) => file)).toEqual(['/bin/sh', '/bin/sh'])
  })
})

describe('checkPiHealth lookup on Windows', () => {
  const NPM_DIR = 'C:\\Users\\dev\\AppData\\Roaming\\npm'
  const SHIM = `${NPM_DIR}\\pi.cmd`
  const ENTRY = `${NPM_DIR}\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js`
  const NODE = 'C:\\Program Files\\nodejs\\node.exe'
  const SHIM_TEXT =
    '@ECHO off\r\nSETLOCAL\r\nCALL :find_dp0\r\n' +
    '"%_prog%"  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js" %*\r\n'

  /** `where` answers for these names; anything else exits 1 like `where` does. */
  let whereAnswers: Record<string, string>

  beforeEach(() => {
    setPlatform('win32')
    lookup.windowsDisk.clear()
    lookup.windowsDisk.set(SHIM, SHIM_TEXT)
    lookup.windowsDisk.set(ENTRY, '')
    whereAnswers = {
      pi: `${NPM_DIR}\\pi\r\n${SHIM}\r\n${NPM_DIR}\\pi.ps1\r\n`,
      node: `${NODE}\r\n`,
    }
    lookup.loginShellPath.mockReset()
    lookup.execFile.mockReset()
    lookup.execFile.mockImplementation((file, args, _options, callback) => {
      if (file === 'where') {
        const answer = whereAnswers[args[0] ?? '']
        if (answer === undefined) callback(new Error('Command failed: where'), '', '')
        else callback(null, answer, '')
        return
      }
      callback(null, `${MIN_PI_VERSION}\n`, '')
    })
  })

  afterEach(() => {
    setPlatform(ORIGINAL_PLATFORM)
    lookup.windowsDisk.clear()
  })

  it("runs the .cmd shim's entry script through node.exe", async () => {
    expect(await checkPiHealth()).toEqual({
      ok: true,
      binaryPath: NODE,
      prefixArgs: [ENTRY],
      version: MIN_PI_VERSION,
      minVersion: MIN_PI_VERSION,
    })
    expect(calls(NODE)).toEqual([
      [NODE, [ENTRY, '--version'], { timeout: 15_000, env: { PATH: '/usr/bin:/bin' } }],
    ])
    const wheres = calls('where')
    expect(wheres.map(([, args]) => args)).toContainEqual(['pi'])
    expect(wheres.every(([, , options]) => options.timeout === 15_000)).toBe(true)
    expect(lookup.loginShellPath).not.toHaveBeenCalled()
  })

  it('prefers the node.exe beside the shim', async () => {
    const beside = `${NPM_DIR}\\node.exe`
    lookup.windowsDisk.set(beside, '')

    const health = await checkPiHealth()

    expect(health.binaryPath).toBe(beside)
    expect(health.prefixArgs).toEqual([ENTRY])
  })

  it('reports not-found when `where pi` fails', async () => {
    delete whereAnswers.pi

    expect(await checkPiHealth()).toEqual({
      ok: false,
      minVersion: MIN_PI_VERSION,
      reason: 'not-found',
      message:
        'The pi coding agent was not found on your PATH. Install it with: ' +
        'npm install -g @earendil-works/pi-coding-agent',
    })
  })

  it('reports a shim it cannot read as found but not runnable', async () => {
    lookup.windowsDisk.set(SHIM, null)

    const health = await checkPiHealth()

    expect(health.ok).toBe(false)
    expect(health.reason).toBe('version-check-failed')
    expect(health.message).toContain(`Found pi at ${SHIM}`)
    expect(calls(NODE)).toEqual([])
  })

  it('reports no-node when node.exe cannot be found', async () => {
    delete whereAnswers.node

    const health = await checkPiHealth()

    expect(health.ok).toBe(false)
    expect(health.reason).toBe('version-check-failed')
    expect(health.message).toContain('node.exe could not be located')
  })
})
