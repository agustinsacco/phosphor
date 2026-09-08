import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())

// promisify(execFile) is captured at module load, so stub the callback form
// and give it the __promisify__ hook util.promisify looks for.
vi.mock('node:child_process', () => ({
  execFile: Object.assign(execFileMock, {
    [Symbol.for('nodejs.util.promisify.custom')]: (
      ...args: unknown[]
    ): Promise<{ stdout: string }> =>
      new Promise((resolve, reject) => {
        execFileMock(...args, (err: Error | null, stdout: string) =>
          err ? reject(err) : resolve({ stdout }),
        )
      }),
  }),
}))

import { getLoginShellEnv, getLoginShellPath, piProcessEnv, resetShellPathCache } from './shell-env'

const ORIGINAL_PLATFORM = process.platform
const ORIGINAL_ENV = { ...process.env }

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

/** Resolve the Nth invocation with `stdout`; earlier ones reject. */
function shellReturns(stdout: string, failFirst = 0): void {
  let calls = 0
  execFileMock.mockImplementation((...args: unknown[]) => {
    const done = args[args.length - 1] as (e: Error | null, out?: string) => void
    calls++
    if (calls <= failFirst) done(new Error('shell failed'))
    else done(null, stdout)
  })
}

beforeEach(() => {
  resetShellPathCache()
  execFileMock.mockReset()
  setPlatform('darwin')
  process.env.SHELL = '/bin/zsh'
})

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM)
  process.env = { ...ORIGINAL_ENV }
  resetShellPathCache()
})

describe('getLoginShellPath', () => {
  it('returns the trimmed PATH printed by the login shell', async () => {
    shellReturns('/opt/homebrew/bin:/usr/bin\n')
    expect(await getLoginShellPath()).toBe('/opt/homebrew/bin:/usr/bin')
  })

  it('invokes the shell with -lic first so rc files run', async () => {
    shellReturns('/usr/bin')
    await getLoginShellPath()
    expect(execFileMock.mock.calls[0]![0]).toBe('/bin/zsh')
    expect(execFileMock.mock.calls[0]![1]).toEqual(['-lic', 'printf %s "$PATH"'])
  })

  it('falls back to -lc when the interactive form fails', async () => {
    shellReturns('/usr/bin', 1)
    expect(await getLoginShellPath()).toBe('/usr/bin')
    expect(execFileMock.mock.calls[1]![1]).toEqual(['-lc', 'printf %s "$PATH"'])
  })

  it('returns null when every shell form fails', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      ;(args[args.length - 1] as (e: Error) => void)(new Error('nope'))
    })
    expect(await getLoginShellPath()).toBeNull()
  })

  it('rejects output with no path separator', async () => {
    shellReturns('not-a-path')
    expect(await getLoginShellPath()).toBeNull()
  })

  it('takes the last line, ignoring rc-file chatter', async () => {
    shellReturns('welcome to your shell\n/usr/local/bin:/usr/bin')
    expect(await getLoginShellPath()).toBe('/usr/local/bin:/usr/bin')
  })

  it('caches the result so the shell is only spawned once', async () => {
    shellReturns('/usr/bin')
    await getLoginShellPath()
    await getLoginShellPath()
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it('shares one in-flight resolution between concurrent callers', async () => {
    shellReturns('/usr/bin')
    const [a, b] = await Promise.all([getLoginShellPath(), getLoginShellPath()])
    expect(a).toBe(b)
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it('caches a null result too, rather than retrying forever', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      ;(args[args.length - 1] as (e: Error) => void)(new Error('nope'))
    })
    await getLoginShellPath()
    await getLoginShellPath()
    // Two forms tried on the first call only.
    expect(execFileMock).toHaveBeenCalledTimes(2)
  })

  it('re-resolves after the cache is reset', async () => {
    shellReturns('/usr/bin')
    await getLoginShellPath()
    resetShellPathCache()
    await getLoginShellPath()
    expect(execFileMock).toHaveBeenCalledTimes(2)
  })

  it('uses process.env.PATH directly on Windows without spawning a shell', async () => {
    setPlatform('win32')
    process.env.PATH = 'C:\\Windows'
    expect(await getLoginShellPath()).toBe('C:\\Windows')
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('defaults to /bin/zsh when SHELL is unset', async () => {
    delete process.env.SHELL
    shellReturns('/usr/bin')
    await getLoginShellPath()
    expect(execFileMock.mock.calls[0]![0]).toBe('/bin/zsh')
  })
})

describe('piProcessEnv', () => {
  it('puts the shell PATH ahead of the inherited one', async () => {
    process.env.PATH = '/usr/bin:/bin'
    shellReturns('/opt/homebrew/bin')
    const env = await piProcessEnv()
    expect(env.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin')
  })

  it('de-duplicates repeated PATH entries, keeping first occurrence order', async () => {
    process.env.PATH = '/usr/bin:/bin'
    shellReturns('/usr/bin:/opt/bin')
    expect((await piProcessEnv()).PATH).toBe('/usr/bin:/opt/bin:/bin')
  })

  it('drops empty PATH segments', async () => {
    process.env.PATH = '/usr/bin::/bin'
    shellReturns('/opt/bin')
    expect((await piProcessEnv()).PATH).toBe('/opt/bin:/usr/bin:/bin')
  })

  it('leaves the inherited PATH untouched when the shell PATH is unavailable', async () => {
    process.env.PATH = '/usr/bin:/bin'
    execFileMock.mockImplementation((...args: unknown[]) => {
      ;(args[args.length - 1] as (e: Error) => void)(new Error('nope'))
    })
    expect((await piProcessEnv()).PATH).toBe('/usr/bin:/bin')
  })

  it('merges extra vars and lets them override the base env', async () => {
    shellReturns('/usr/bin')
    const env = await piProcessEnv({ PHOSPHOR_TEST: '1', PATH: '/override' })
    expect(env.PHOSPHOR_TEST).toBe('1')
    expect(env.PATH).toBe('/override')
  })

  it('carries the rest of process.env through', async () => {
    process.env.SOME_MARKER = 'marker-value'
    shellReturns('/usr/bin')
    expect((await piProcessEnv()).SOME_MARKER).toBe('marker-value')
  })
})

/** NUL-delimited `env -0` output from a fixture map. */
function envRecords(vars: Record<string, string>): string {
  return (
    Object.entries(vars)
      .map(([k, v]) => `${k}=${v}`)
      .join('\0') + '\0'
  )
}

describe('getLoginShellEnv', () => {
  it('imports allowlisted provider vars', async () => {
    shellReturns(envRecords({ AWS_PROFILE: 'dev', ANTHROPIC_API_KEY: 'sk-ant' }))
    expect(await getLoginShellEnv()).toEqual({ AWS_PROFILE: 'dev', ANTHROPIC_API_KEY: 'sk-ant' })
  })

  it('drops vars outside the allowlist', async () => {
    shellReturns(
      envRecords({ AWS_REGION: 'us-east-1', SECRET_DIARY: 'no', ELECTRON_RUN_AS_NODE: '1' }),
    )
    const env = await getLoginShellEnv()
    expect(env).toEqual({ AWS_REGION: 'us-east-1' })
  })

  it('preserves values containing newlines', async () => {
    shellReturns(envRecords({ GOOGLE_APPLICATION_CREDENTIALS: '{\n  "a": 1\n}' }))
    expect((await getLoginShellEnv()).GOOGLE_APPLICATION_CREDENTIALS).toBe('{\n  "a": 1\n}')
  })

  it('ignores rc-file chatter before the first record', async () => {
    shellReturns('welcome to your shell\n' + envRecords({ AWS_PROFILE: 'dev' }))
    expect(await getLoginShellEnv()).toEqual({ AWS_PROFILE: 'dev' })
  })

  it('returns {} when the shell prints nothing parseable', async () => {
    shellReturns('/opt/homebrew/bin:/usr/bin')
    expect(await getLoginShellEnv()).toEqual({})
  })

  it('returns {} when every shell form fails', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      ;(args[args.length - 1] as (e: Error) => void)(new Error('nope'))
    })
    expect(await getLoginShellEnv()).toEqual({})
  })

  it('spawns no shell on Windows', async () => {
    setPlatform('win32')
    expect(await getLoginShellEnv()).toEqual({})
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('caches, sharing one in-flight resolution between callers', async () => {
    shellReturns(envRecords({ AWS_PROFILE: 'dev' }))
    const [a, b] = await Promise.all([getLoginShellEnv(), getLoginShellEnv()])
    expect(a).toEqual(b)
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })
})

describe('piProcessEnv provider credentials', () => {
  it('supplies shell credentials a GUI launch did not inherit', async () => {
    delete process.env.AWS_PROFILE
    shellReturns(envRecords({ AWS_PROFILE: 'dev', AWS_REGION: 'eu-central-1' }))
    const env = await piProcessEnv()
    expect(env.AWS_PROFILE).toBe('dev')
    expect(env.AWS_REGION).toBe('eu-central-1')
  })

  it('does not override a value already in the inherited env', async () => {
    process.env.AWS_PROFILE = 'inherited'
    shellReturns(envRecords({ AWS_PROFILE: 'from-profile' }))
    expect((await piProcessEnv()).AWS_PROFILE).toBe('inherited')
  })

  it('still lets explicit extra vars win over the shell', async () => {
    delete process.env.AWS_REGION
    shellReturns(envRecords({ AWS_REGION: 'eu-central-1' }))
    expect((await piProcessEnv({ AWS_REGION: 'us-east-1' })).AWS_REGION).toBe('us-east-1')
  })
})
