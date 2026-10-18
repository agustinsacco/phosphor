import { chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONTROL_URL } from '@phosphor/shared/control-api'
import { EXIT } from '../checks'
import { ControlFailure } from './client'
import {
  commandStore,
  confirmedLine,
  controlResult,
  prepareControl,
  traceCommand,
  waitForPoll,
  withCommandLock,
  type ControlContext,
} from './command'
import { identityDirectory, IdentityFailure, type IdentityStore } from './identity'
import { LockBusy, type LockPorts } from './lock'
import { controlMachine, oldIdentity, type ControlMachine } from './__fixtures__/machine'

const MISMATCH =
  'This machine is signed in to https://example.com, but the config points at https://other.example. Run phosphor logout --local, then phosphor setup.'
const INCOMPLETE =
  'Identity incomplete. Use an owned regular key, no symlink, chmod 600 host-key.*.pem; run phosphor setup.'
const UNSAFE =
  'Unsafe identity storage. Use files owned by you, no symlinks, chmod 600 host-key.*.pem host.json and chmod 700 identity.'
const lockPorts: LockPorts = { pid: 4242, isAlive: (pid) => pid === 4242 }

let machine: ControlMachine
let directory: string
beforeEach(async () => {
  machine = await controlMachine()
  directory = identityDirectory(machine.configPath)
})
afterEach(async () => {
  await machine.cleanup()
})
const pointConfigAt = (url: string) =>
  writeFile(machine.configPath, JSON.stringify({ ...machine.config, control: { url } }))
const breakKey = () =>
  writeFile(join(directory, `host-key.${oldIdentity.hostId}.pem`), 'not a key', { mode: 0o600 })
const storeWith = (load: IdentityStore['load']): IdentityStore => ({ ...machine.store, load })
const rejection = (work: Promise<unknown>) =>
  work.then(
    () => {
      throw new Error('expected a rejection')
    },
    (error: unknown) => error,
  )

describe('prepareControl refuses before any control traffic', () => {
  it.each([
    ['missing', () => rm(machine.configPath)],
    ['unparseable', () => writeFile(machine.configPath, '{')],
    ['plain-http control url', () => pointConfigAt('http://public.example')],
    ['control url with a path', () => pointConfigAt('https://example.com/api')],
  ])('refuses a %s config without reading the identity', async (_kind, breakConfig) => {
    await breakConfig()
    const load = vi.fn<IdentityStore['load']>(async () => null)
    const context: ControlContext = { ...machine.context, store: storeWith(load) }
    const failure = prepareControl(context, true)
    await expect(failure).rejects.toBeInstanceOf(IdentityFailure)
    await expect(failure).rejects.toThrow(
      /^Config is not usable\. Run phosphor setup to check it\.$/,
    )
    expect(load).not.toHaveBeenCalled()
    expect(machine.calls).toEqual([])
  })

  it('refuses when the Host has no uid, before reading the identity', async () => {
    const load = vi.fn<IdentityStore['load']>(async () => null)
    const context = { ...machine.context, uid: undefined, store: storeWith(load) }
    await expect(prepareControl(context)).rejects.toThrow('Config is not usable.')
    expect(load).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'refuses a complete identity from another origin (recover: %s)',
    async (recover) => {
      await machine.enrollOld()
      await pointConfigAt('https://other.example')
      const failure = prepareControl(machine.context, recover)
      await expect(failure).rejects.toBeInstanceOf(IdentityFailure)
      await expect(failure).rejects.toThrow(MISMATCH)
      expect(machine.calls).toEqual([])
    },
  )

  it.each([false, true])(
    'refuses an incomplete identity from another origin ahead of recovery (recover: %s)',
    async (recover) => {
      await machine.enrollOld()
      await breakKey()
      await pointConfigAt('https://other.example')
      const failure = await rejection(prepareControl(machine.context, recover))
      expect(failure).toBeInstanceOf(IdentityFailure)
      expect(failure).toMatchObject({ message: MISMATCH })
      expect((failure as IdentityFailure).incomplete).toBeUndefined()
      expect(machine.calls).toEqual([])
    },
  )

  it.each([
    ['https://example.com:8443', 'https://example.com:8443'],
    ['http://localhost:54350', 'http://localhost:54350'],
  ])('treats a different port or scheme as another origin: %s', async (url, shown) => {
    await machine.enrollOld()
    await pointConfigAt(url)
    await expect(prepareControl(machine.context)).rejects.toThrow(
      `This machine is signed in to https://example.com, but the config points at ${shown}.`,
    )
    expect(machine.calls).toEqual([])
  })

  it('refuses an incomplete identity unless the caller recovers it', async () => {
    await machine.enrollOld()
    await breakKey()
    const failure = await rejection(prepareControl(machine.context))
    expect(failure).toBeInstanceOf(IdentityFailure)
    expect(failure).toMatchObject({ message: INCOMPLETE, incomplete: oldIdentity })
    const recovered = await prepareControl(machine.context, true)
    expect(recovered.loaded).toBeNull()
    expect(recovered.url).toBe('https://example.com')
    expect(recovered.store).toBe(machine.store)
    expect(machine.calls).toEqual([])
  })

  it.each([
    ['an unexpected error', () => new Error('disk failure with /secret/path')],
    ['an identity failure that is not incomplete', () => new IdentityFailure('Invalid identity.')],
  ])('rethrows %s from the store even when recovering', async (_kind, make) => {
    const error = make()
    const context = {
      ...machine.context,
      store: storeWith(async () => {
        throw error
      }),
    }
    await expect(prepareControl(context, true)).rejects.toBe(error)
    expect(machine.calls).toEqual([])
  })

  it.each([
    [
      'invalid host.json',
      async () => {
        await mkdir(directory, { mode: 0o700 })
        await writeFile(join(directory, 'host.json'), '{', { mode: 0o600 })
      },
      'Invalid identity. Run phosphor logout --local, then phosphor setup.',
    ],
    [
      'group-readable identity directory',
      async () => {
        await mkdir(directory, { mode: 0o700 })
        await chmod(directory, 0o750)
      },
      UNSAFE,
    ],
  ])('refuses a stored %s even when recovering', async (_kind, arrange, message) => {
    await arrange()
    const failure = await rejection(prepareControl(machine.context, true))
    expect(failure).toBeInstanceOf(IdentityFailure)
    expect(failure).toMatchObject({ message })
    expect((failure as IdentityFailure).incomplete).toBeUndefined()
    expect(machine.calls).toEqual([])
  })

  it('prepares the configured origin, or the default one, without traffic when signed out', async () => {
    const prepared = await prepareControl(machine.context)
    expect(prepared).toMatchObject({ url: 'https://example.com', loaded: null })
    expect(prepared.store).toBe(machine.store)
    const { control: _control, ...withoutControl } = machine.config
    await writeFile(machine.configPath, JSON.stringify(withoutControl))
    expect((await prepareControl(machine.context)).url).toBe(DEFAULT_CONTROL_URL)
    expect(machine.calls).toEqual([])
  })

  it('uses the context store when given one', () => {
    expect(commandStore(machine.context)).toBe(machine.store)
  })
})

describe('withCommandLock', () => {
  const context = () => ({ ...machine.context, lockPorts })

  it('returns the work result and releases the lock', async () => {
    expect(await withCommandLock(context(), async () => 'done')).toBe('done')
    expect(await readdir(directory)).toEqual([])
    expect(await withCommandLock(context(), async () => 'again')).toBe('again')
  })

  it('releases the lock and rethrows the same error when the work throws', async () => {
    const error = new Error('work failed')
    await expect(
      withCommandLock(context(), async () => {
        expect(await readdir(directory)).toEqual(['.lock'])
        throw error
      }),
    ).rejects.toBe(error)
    expect(await readdir(directory)).toEqual([])
    expect(await withCommandLock(context(), async () => 'after')).toBe('after')
  })

  it('refuses a second holder without running its work, and maps it to a retry', async () => {
    const inner = vi.fn(async () => 'inner')
    let refused: unknown
    await withCommandLock(context(), async () => {
      refused = await withCommandLock(context(), inner).catch((error: unknown) => error)
    })
    expect(inner).not.toHaveBeenCalled()
    expect(refused).toBeInstanceOf(LockBusy)
    expect(controlResult(refused)).toEqual({
      exitCode: EXIT.tempfail,
      message: 'Another phosphor login or logout is running (pid 4242).',
    })
    expect(await readdir(directory)).toEqual([])
  })

  it.each([
    ['a group-readable directory', 0o750, process.getuid?.()],
    ['no uid', 0o700, undefined],
  ])('refuses %s without running the work or writing a lock', async (_kind, mode, uid) => {
    await mkdir(directory, { mode: 0o700 })
    await chmod(directory, mode)
    const work = vi.fn(async () => 'never')
    const failure = withCommandLock({ ...context(), uid }, work)
    await expect(failure).rejects.toBeInstanceOf(IdentityFailure)
    await expect(failure).rejects.toThrow(UNSAFE)
    expect(work).not.toHaveBeenCalled()
    expect(await readdir(directory)).toEqual([])
  })
})

describe('controlResult maps failures without echoing unknown text', () => {
  it.each([
    [
      'a busy lock',
      new LockBusy(123),
      EXIT.tempfail,
      'Another phosphor login or logout is running (pid 123).',
    ],
    ['an identity failure', new IdentityFailure('Bad identity.'), EXIT.config, 'Bad identity.'],
    [
      'a removed machine',
      new ControlFailure('gone'),
      EXIT.noperm,
      'This machine was removed from the account.',
    ],
    [
      'an offline control plane',
      new ControlFailure('offline'),
      EXIT.tempfail,
      'The control plane could not be reached.',
    ],
    [
      'an unavailable control plane',
      new ControlFailure('unavailable'),
      EXIT.tempfail,
      'Control request failed (unavailable).',
    ],
    [
      'an unauthenticated request',
      new ControlFailure('unauthenticated'),
      EXIT.tempfail,
      'Control request failed (unauthenticated).',
    ],
    [
      'an unexpected error',
      new Error('token=secret'),
      EXIT.internal,
      'The command could not finish.',
    ],
    ['a thrown string', 'token=secret', EXIT.internal, 'The command could not finish.'],
    ['nothing', undefined, EXIT.internal, 'The command could not finish.'],
  ])('maps %s', (_kind, error, exitCode, message) => {
    expect(controlResult(error)).toEqual({ exitCode, message })
    expect(controlResult(error, new AbortController().signal)).toEqual({ exitCode, message })
  })

  it('reports cancellation ahead of any failure once the signal aborted', () => {
    const abort = new AbortController()
    abort.abort()
    for (const error of [
      new LockBusy(1),
      new IdentityFailure('x'),
      new ControlFailure('gone'),
      new Error('x'),
      undefined,
    ])
      expect(controlResult(error, abort.signal)).toEqual({ exitCode: 130, message: 'Cancelled.' })
  })
})

describe('traceCommand', () => {
  it('logs an internal exit and rethrows the same error when the command throws', async () => {
    const log = vi.fn()
    const error = new Error('boom')
    const trace = '0123456789abcdef'
    await expect(
      traceCommand({ ...machine.context, log, trace }, 'login', async () => {
        throw error
      }),
    ).rejects.toBe(error)
    expect(log.mock.calls).toEqual([
      ['host', 'start', { command: 'login', trace, hostVersion: expect.any(String) }],
      ['host', 'end', { command: 'login', trace, exitCode: EXIT.internal }],
    ])
  })

  it.each(['', 'not-a-trace', '0123456789ABCDEF', '0123456789abcdef0'])(
    'replaces the malformed caller trace %j',
    async (trace) => {
      const seen = await traceCommand({ ...machine.context, trace }, 'status', async (traced) => ({
        exitCode: 0,
        trace: traced.trace,
      }))
      expect(seen.trace).toMatch(/^[0-9a-f]{16}$/)
      expect(seen.trace).not.toBe(trace)
    },
  )
})

describe('waitForPoll', () => {
  it('stops the default wait once the command signal aborts', async () => {
    const abort = new AbortController()
    const { wait: _wait, ...context } = machine.context
    const waiting = waitForPoll({ ...context, signal: abort.signal }, 60_000)
    abort.abort()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('passes the command signal to an injected wait', async () => {
    const wait = vi.fn(async () => {})
    await waitForPoll({ ...machine.context, wait }, 5000)
    expect(wait).toHaveBeenCalledWith(5000, machine.context.signal)
  })
})

it('confirmedLine quotes the label so it cannot break the line', () => {
  expect(confirmedLine({ label: 'a"b\nc\u001b[2J', owner: { login: null } })).toBe(
    'This machine is now "a\\"b\\nc\\u001b[2J" on your account.',
  )
  expect(confirmedLine({ label: 'bee1', owner: { login: 'me' } })).toBe(
    'This machine is now "bee1" on @me\'s account.',
  )
})
