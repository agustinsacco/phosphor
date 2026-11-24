import type * as ChildProcess from 'node:child_process'
import type { ExecFileOptions } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MIN_PI_VERSION } from '@shared/models'

/**
 * How `checkPiHealth` finds pi, through its public entry. Lookups run the
 * real `/bin/sh` over real directories, so these pin what is found, not how
 * the lookup is spelled.
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

vi.mock('@phosphor/session-runtime/pi/shell-env', () => ({
  getLoginShellPath: () => lookup.loginShellPath(),
  piProcessEnv: async () => ({ PATH: '/usr/bin:/bin' }),
}))

import { checkPiHealth } from './health'

const ORIGINAL_PATH = process.env.PATH

/** Calls the fake saw, as [file, args, options]. */
function calls(file: string): Array<[string, string[], ExecFileOptions]> {
  return lookup.execFile.mock.calls
    .filter(([called]) => called === file)
    .map(([called, args, options]) => [called, args, options])
}

describe('checkPiHealth lookup', () => {
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
