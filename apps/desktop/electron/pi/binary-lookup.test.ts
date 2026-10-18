import type * as ChildProcess from 'node:child_process'
import type { ExecFileOptions } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `execFile` is a spy over the real one, so the argv each lookup hands the
 * shell is visible while a real `/bin/sh` still answers it.
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

vi.mock('./shell-env', () => ({ getLoginShellPath: () => lookup.loginShellPath() }))

import { lookupPosixBinary, windowsWhereOutput } from './binary-lookup'

const SCRIPT = 'command -v "$1"'
const ORIGINAL_PATH = process.env.PATH

function useRealExecFile(): void {
  lookup.execFile.mockReset()
  lookup.execFile.mockImplementation((file, args, options, callback) =>
    lookup.realExecFile?.(file, args, options, callback),
  )
}

describe.skipIf(process.platform === 'win32')('lookupPosixBinary', () => {
  let root: string
  let loginDir: string
  let processDir: string

  function install(dir: string, name: string): string {
    const path = join(dir, name)
    writeFileSync(path, '#!/bin/sh\n')
    chmodSync(path, 0o755)
    return path
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'phosphor-binary-lookup-'))
    loginDir = join(root, 'login')
    processDir = join(root, 'process')
    mkdirSync(loginDir)
    mkdirSync(processDir)
    useRealExecFile()
    lookup.loginShellPath.mockReset()
    lookup.loginShellPath.mockResolvedValue(loginDir)
    process.env.PATH = processDir
  })

  afterEach(() => {
    process.env.PATH = ORIGINAL_PATH
    rmSync(root, { recursive: true, force: true })
  })

  it('hands the shell a fixed script and the name as $1, for any name', async () => {
    const marker = join(root, 'ran')
    const names = [
      `nope; : > '${marker}'`,
      `$(: > '${marker}')`,
      `\`: > '${marker}'\``,
      `nope' ; : > '${marker}' ; '`,
      `nope" ; : > "${marker}" ; "`,
      'nope; echo /evil/claude',
      'nope claude',
    ]
    install(loginDir, 'claude')

    for (const name of names) {
      lookup.execFile.mockClear()
      expect(await lookupPosixBinary(name)).toBeNull()
      expect(lookup.execFile.mock.calls.map(([file, args]) => [file, args])).toEqual([
        ['/bin/sh', ['-c', SCRIPT, 'sh', name]],
        ['/bin/sh', ['-c', SCRIPT, 'sh', name]],
      ])
    }
    expect(existsSync(marker)).toBe(false)
  })

  it('finds a file whose name holds shell syntax, as named', async () => {
    for (const name of ['my tool', 'a;b', '$(x)', '`x`', "it's", 'say"hi"']) {
      const path = install(loginDir, name)
      expect(await lookupPosixBinary(name)).toBe(path)
    }
  })

  it('asks the login-shell PATH first, bounded', async () => {
    const login = install(loginDir, 'claude')
    install(processDir, 'claude')

    expect(await lookupPosixBinary('claude')).toBe(login)
    expect(lookup.execFile.mock.calls.map(([, , options]) => options)).toEqual([
      { timeout: 15_000, env: { ...process.env, PATH: loginDir } },
    ])
  })

  it('falls back to the process PATH, bounded', async () => {
    const fallback = install(processDir, 'claude')

    expect(await lookupPosixBinary('claude')).toBe(fallback)
    expect(lookup.execFile.mock.calls[1]?.[2]).toEqual({ timeout: 15_000, env: { ...process.env } })
  })

  it.each([null, ''])('asks only the process PATH when the login PATH is %j', async (value) => {
    lookup.loginShellPath.mockResolvedValue(value)
    install(loginDir, 'claude')
    const fallback = install(processDir, 'claude')

    expect(await lookupPosixBinary('claude')).toBe(fallback)
    expect(lookup.execFile).toHaveBeenCalledTimes(1)
  })

  it('answers null when neither PATH has the name', async () => {
    expect(await lookupPosixBinary('claude')).toBeNull()
    expect(lookup.execFile).toHaveBeenCalledTimes(2)
  })

  it('goes on to the process PATH when a lookup fails or runs past its bound', async () => {
    install(loginDir, 'claude')
    const fallback = install(processDir, 'claude')
    lookup.execFile.mockImplementationOnce((_file, _args, _options, callback) =>
      callback(Object.assign(new Error('Command failed'), { killed: true }), '', ''),
    )

    expect(await lookupPosixBinary('claude')).toBe(fallback)
  })

  it('takes the last line of the output, trimmed, and skips an empty answer', async () => {
    lookup.execFile
      .mockImplementationOnce((_file, _args, _options, callback) => callback(null, '  \n', ''))
      .mockImplementationOnce((_file, _args, _options, callback) =>
        callback(null, 'rc chatter\n  /opt/bin/claude  \n', ''),
      )

    expect(await lookupPosixBinary('claude')).toBe('/opt/bin/claude')
  })
})

describe('windowsWhereOutput', () => {
  const STDOUT = 'C:\\npm\\claude\r\nC:\\npm\\claude.cmd\r\nC:\\npm\\claude.ps1\r\n'

  beforeEach(() => {
    lookup.execFile.mockReset()
  })

  it("returns `where`'s stdout as printed, without picking from it", async () => {
    lookup.execFile.mockImplementation((_file, _args, _options, callback) =>
      callback(null, STDOUT, ''),
    )

    expect(await windowsWhereOutput('claude')).toBe(STDOUT)
    expect(
      lookup.execFile.mock.calls.map(([file, args, options]) => [file, args, options]),
    ).toEqual([['where', ['claude'], { timeout: 15_000 }]])
  })

  it('passes the name as one argument, with no shell between', async () => {
    lookup.execFile.mockImplementation((_file, _args, _options, callback) => callback(null, '', ''))
    const name = 'claude & echo C:\\evil.exe'

    await windowsWhereOutput(name)

    expect(lookup.execFile.mock.calls[0]?.[1]).toEqual([name])
    expect(lookup.execFile.mock.calls[0]?.[2]).not.toHaveProperty('shell')
  })

  it("answers '' when `where` finds nothing, fails or runs past its bound", async () => {
    lookup.execFile.mockImplementation((_file, _args, _options, callback) =>
      callback(Object.assign(new Error('Command failed: where'), { code: 1 }), '', ''),
    )

    expect(await windowsWhereOutput('claude')).toBe('')
  })
})

it('packages preserves the shared binary resolver identity', async () => {
  const packages = await import('./packages')
  const binaryLookup = await import('./binary-lookup')
  expect(packages.resolveBinary).toBe(binaryLookup.resolveBinary)
})
