import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { fixture } from '../update/__fixtures__/release'
import { acquireInstallLock } from '../update/lock'
import { runUninstall } from './uninstall'
const logout = vi.hoisted(() => ({ run: vi.fn(async () => ({ exitCode: 0, message: 'ok' })) }))
vi.mock('./logout', () => ({ runLogout: logout.run }))
const fixtures: ReturnType<typeof fixture>[] = []
function setup() {
  const f = fixture()
  fixtures.push(f)
  for (const path of ['.config/phosphor-host', '.local/state/phosphor-host']) {
    mkdirSync(join(f.home, path), { recursive: true })
    writeFileSync(join(f.home, path, 'marker'), 'keep')
  }
  return f
}
afterEach(() => {
  logout.run.mockReset()
  logout.run.mockResolvedValue({ exitCode: 0, message: 'ok' })
  for (const f of fixtures.splice(0)) f.cleanup()
})
it('removes program and own launcher, uninstalls service first and keeps config, identity, state and backup', async () => {
  const f = setup(),
    calls: string[][] = []
  const unit = join(f.home, '.config/systemd/user/phosphor-host.service')
  mkdirSync(join(unit, '..'), { recursive: true })
  writeFileSync(unit, 'unit')
  f.context.service = {
    runner: async (_p, args) => {
      calls.push([...args])
      expect(existsSync(f.lib)).toBe(true)
      return { code: 0, stdout: '', stderr: '' }
    },
  }
  const backup = join(f.home, '.local/bin/phosphor.before-release')
  writeFileSync(backup, 'original')
  expect(await runUninstall(f.context)).toBe(0)
  expect(existsSync(f.lib)).toBe(false)
  expect(existsSync(join(f.home, '.local/bin/phosphor'))).toBe(false)
  expect(calls.some((args) => args.includes('disable'))).toBe(true)
  expect(existsSync(unit)).toBe(false)
  for (const path of ['.config/phosphor-host', '.local/state/phosphor-host'])
    expect(readFileSync(join(f.home, path, 'marker'), 'utf8')).toBe('keep')
  expect(readFileSync(backup, 'utf8')).toBe('original')
  expect(f.messages.join('\n')).toContain('Kept config and identity:')
  expect(logout.run).not.toHaveBeenCalled()
})
it.each(['file', 'link'])('leaves a foreign launcher %s alone', async (kind) => {
  const f = setup(),
    launcher = join(f.home, '.local/bin/phosphor')
  rmSync(launcher)
  if (kind === 'file') writeFileSync(launcher, 'foreign')
  else symlinkSync('foreign', launcher)
  expect(await runUninstall(f.context)).toBe(0)
  expect(kind === 'file' ? readFileSync(launcher, 'utf8') : readlinkSync(launcher)).toBe('foreign')
})
it('source installs remove no program or launcher', async () => {
  const f = setup()
  f.context.update = { node: process.execPath }
  expect(await runUninstall(f.context)).toBe(0)
  expect(existsSync(f.lib)).toBe(true)
  expect(readlinkSync(join(f.home, '.local/bin/phosphor'))).toBe(
    join(f.lib, 'current/bin/phosphor'),
  )
  expect(f.messages.join('\n')).toContain('Source install:')
})
it('purges only after successful logout, and failed logout keeps everything', async () => {
  const f = setup()
  logout.run.mockResolvedValueOnce({ exitCode: 75, message: 'fail' })
  expect(await runUninstall(f.context, true, true)).toBe(75)
  expect(existsSync(f.lib)).toBe(true)
  expect(existsSync(join(f.home, '.config/phosphor-host/marker'))).toBe(true)
  expect(existsSync(join(f.home, '.local/state/phosphor-host/marker'))).toBe(true)
  expect(await runUninstall(f.context, true, true)).toBe(0)
  expect(existsSync(f.lib)).toBe(false)
  expect(existsSync(join(f.home, '.config/phosphor-host'))).toBe(false)
  expect(existsSync(join(f.home, '.local/state/phosphor-host'))).toBe(false)
})
it('requires both purge flags and a default config path, and refuses a held install lock', async () => {
  const f = setup()
  expect(await runUninstall(f.context, true)).toBe(64)
  expect(await runUninstall(f.context, false, true)).toBe(64)
  expect(
    await runUninstall({ ...f.context, configPath: join(f.home, 'other.json') }, true, true),
  ).toBe(64)
  const release = acquireInstallLock(f.lib)
  try {
    expect(await runUninstall(f.context)).toBe(75)
  } finally {
    release()
  }
  expect(logout.run).not.toHaveBeenCalled()
  expect(existsSync(f.lib)).toBe(true)
})
it('refuses symlinked data or launcher parents and wrong ownership before deletion', async () => {
  const f = setup(),
    state = join(f.home, '.local/state/phosphor-host')
  expect(await runUninstall({ ...f.context, uid: (f.context.uid ?? 0) + 1 }, true, true)).toBe(75)
  rmSync(state, { recursive: true })
  symlinkSync(f.old, state)
  expect(await runUninstall(f.context, true, true)).toBe(75)
  expect(logout.run).not.toHaveBeenCalled()
  expect(existsSync(f.lib)).toBe(true)
  const bin = join(f.home, '.local/bin')
  rmSync(bin, { recursive: true })
  symlinkSync(f.old, bin)
  expect(await runUninstall(f.context)).toBe(75)
  expect(existsSync(f.lib)).toBe(true)
})
it('leaves the program in place if service uninstall fails', async () => {
  const f = setup(),
    unit = join(f.home, '.config/systemd/user/phosphor-host.service')
  mkdirSync(join(unit, '..'), { recursive: true })
  writeFileSync(unit, 'unit')
  f.context.service = { runner: async () => ({ code: 1, stdout: 'loaded', stderr: '' }) }
  expect(await runUninstall(f.context)).toBe(75)
  expect(existsSync(f.lib)).toBe(true)
  expect(existsSync(unit)).toBe(true)
})
