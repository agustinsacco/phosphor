import { existsSync, mkdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { acquireInstallLock } from '@phosphor/session-runtime/host-install/lock'
import { pinBrainCompatibility } from '../update/brain-compatibility'
import { syntheticBrainBundle } from '../update/__fixtures__/brain-package'
import { fixture } from '../update/__fixtures__/release'
import { runUpdate, type UpdateOptions } from './update'

const fixtures: ReturnType<typeof fixture>[] = []
const setup = () => {
  const f = fixture()
  fixtures.push(f)
  f.context.update!.probe = async () => ({ hostVersion: '1.2.3', protocolVersion: 1, features: [] })
  f.context.packages = async () => []
  f.context.service!.runner = vi.fn(f.context.service!.runner)
  f.release()
  return f
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup()
})

it.each<[string, UpdateOptions]>([
  ['direct', {}],
  ['automatic stage', { stage: true }],
  ['apply an earlier stage', { apply: '1.2.3' }],
  ['offline rollback', { rollback: true }],
])(
  'refuses an ordinary replacement on %s before selecting or restarting',
  async (_name, options) => {
    const f = setup()
    if (options.apply || options.rollback) f.install('1.2.3')
    if (options.rollback)
      writeFileSync(
        join(f.lib, 'install.json'),
        JSON.stringify({ current: '1.0.0', previous: '1.2.3' }),
      )
    // The update process has a different state root than the Brain that claimed this install.
    f.context.env.XDG_STATE_HOME = join(f.home, 'another-state')
    writeFileSync(join(f.lib, '.brain-required'), '1\n', { mode: 0o600 })
    expect(await runUpdate(f.context, options)).toBe(69)
    expect(f.messages.join(' ')).toContain('qualified')
    expect(readlinkSync(join(f.lib, 'current'))).toBe('versions/1.0.0')
    expect(existsSync(join(f.lib, 'versions/1.2.3'))).toBe(!!(options.apply || options.rollback))
    expect(f.context.service!.runner).not.toHaveBeenCalled()
  },
)

it('recognizes a pre-pin Brain at the default root even when the updater uses XDG', async () => {
  const f = setup()
  f.context.env.XDG_STATE_HOME = join(f.home, 'another-state')
  mkdirSync(join(f.home, '.local/state/phosphor-host/brain'), { recursive: true })
  expect(await runUpdate(f.context)).toBe(69)
  expect(readlinkSync(join(f.lib, 'current'))).toBe('versions/1.0.0')
})

it('leaves ordinary installs unaffected', async () => {
  const f = setup()
  expect(await runUpdate(f.context)).toBe(0)
  expect(readlinkSync(join(f.lib, 'current'))).toBe('versions/1.2.3')
})

it('cannot take ownership while a publisher holds the install lock or from an unqualified bundle', () => {
  const f = setup()
  const claim = () =>
    pinBrainCompatibility({ home: f.home, uid: f.context.uid, ...f.context.update })
  const unlock = acquireInstallLock(f.lib)
  try {
    expect(claim).toThrow('Install lock:')
  } finally {
    unlock()
  }
  expect(claim).toThrow('not qualified')
  expect(existsSync(join(f.lib, '.brain-required'))).toBe(false)
})

it('rejects a hostile pin link even when its target is absent', async () => {
  const f = setup()
  symlinkSync('missing', join(f.lib, '.brain-required'))
  expect(await runUpdate(f.context)).toBe(69)
  expect(readlinkSync(join(f.lib, 'current'))).toBe('versions/1.0.0')
})

it.each([false, true])(
  'restores only a compatible prior bundle on failed health (compatible=%s)',
  async (compatible) => {
    const f = setup()
    f.context.platform = 'darwin'
    f.context.arch = 'arm64'
    syntheticBrainBundle(f.install('1.2.3'))
    if (compatible) syntheticBrainBundle(f.old)
    const pin = join(f.lib, '.brain-required')
    const kickstart = vi.fn()
    const lock = () => acquireInstallLock(f.lib)
    f.context.wait = async () => undefined
    f.context.service = {
      runner: async (_program, args) => {
        if (args[0] === 'kickstart') {
          expect(lock).toThrow('Install lock:')
          kickstart()
          // A legacy owner appearing during service health is still checked at rollback.
          writeFileSync(pin, '1\n', { mode: 0o600 })
        }
        return { code: 0, stdout: 'state = running', stderr: '' }
      },
    }
    expect(await runUpdate(f.context, { apply: '1.2.3' })).toBe(75)
    expect(readlinkSync(join(f.lib, 'current'))).toBe(
      compatible ? 'versions/1.0.0' : 'versions/1.2.3',
    )
    expect(kickstart).toHaveBeenCalledTimes(compatible ? 2 : 1)
    lock()() // Released only after the failed health and any rollback restart.
    expect(f.messages.join(' ')).toContain(compatible ? 'rolled back' : 'cannot be safely restored')
  },
)

it('rechecks Brain compatibility after the async service inspection and before selection', async () => {
  const f = setup()
  f.install('1.2.3')
  f.context.service = {
    runner: async () => {
      mkdirSync(join(f.home, '.local/state/phosphor-host/brain'), { recursive: true })
      return { code: 3, stdout: '', stderr: '' }
    },
  }
  expect(await runUpdate(f.context, { apply: '1.2.3' })).toBe(69)
  expect(readlinkSync(join(f.lib, 'current'))).toBe('versions/1.0.0')
})

it('admits a qualified staged replacement on a pinned install', async () => {
  const f = setup()
  f.context.platform = 'darwin'
  f.context.arch = 'arm64'
  syntheticBrainBundle(f.install('1.2.3'))
  writeFileSync(join(f.lib, '.brain-required'), '1\n', { mode: 0o600 })
  expect(await runUpdate(f.context, { apply: '1.2.3' })).toBe(0)
  expect(readlinkSync(join(f.lib, 'current'))).toBe('versions/1.2.3')
})

it.each<UpdateOptions>([{ stage: true }, { apply: '1.2.3' }, { rollback: true }])(
  'refuses to publish or select while the shared install lock is held: %j',
  async (options) => {
    const f = setup()
    if (!options.stage) f.install('1.2.3')
    if (options.rollback)
      writeFileSync(
        join(f.lib, 'install.json'),
        JSON.stringify({ current: '1.0.0', previous: '1.2.3' }),
      )
    const unlock = acquireInstallLock(f.lib)
    try {
      expect(await runUpdate(f.context, options)).toBe(75)
      expect(f.messages.join(' ')).toContain('Install lock:')
      expect(readlinkSync(join(f.lib, 'current'))).toBe('versions/1.0.0')
      expect(existsSync(join(f.lib, 'versions/1.2.3'))).toBe(!options.stage)
      expect(f.context.service!.runner).not.toHaveBeenCalled()
    } finally {
      unlock()
    }
  },
)
