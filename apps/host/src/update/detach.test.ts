vi.mock('@phosphor/session-runtime/pi/packages', () => ({ listPackages: async () => [] }))
import { readdirSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { runUpdate } from '../commands/update'
import { fixture } from './__fixtures__/release'
import { insideHostUnit } from './detach'

const HOST_CGROUP =
  '0::/user.slice/user-1000.slice/user@1000.service/app.slice/phosphor-host.service\n'
const fixtures: ReturnType<typeof fixture>[] = []
function setup(cgroup = HOST_CGROUP) {
  const f = fixture()
  fixtures.push(f)
  f.release()
  f.context.update = { ...f.context.update, cgroup }
  f.context.now = () => 1234
  f.context.env = { ...f.context.env, PATH: '/usr/bin', SECRET_TOKEN: 'x' }
  const calls: [string, string[]][] = []
  f.context.service = {
    runner: async (program, args) => {
      calls.push([program, [...args]])
      // systemd-run starts; the service itself reports inactive, so nothing restarts.
      return { code: program === 'systemd-run' ? 0 : 3, stdout: '' }
    },
  }
  return { f, calls }
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup()
})

it('reads only the Host unit itself, on cgroup v1 or v2', () => {
  expect(insideHostUnit(HOST_CGROUP)).toBe(true)
  expect(insideHostUnit('1:name=systemd:/user.slice/app.slice/phosphor-host.service\n')).toBe(true)
  expect(insideHostUnit('0::/user.slice/app.slice/phosphor-update-1.service\n')).toBe(false)
  expect(insideHostUnit('0::/user.slice/session-4.scope\n')).toBe(false)
})

it('hands an update started in a Host lane to its own unit, which a restart cannot stop', async () => {
  const { f, calls } = setup()
  expect(await runUpdate(f.context, { version: '1.2.3' })).toBe(0)
  expect(calls).toEqual([
    [
      'systemd-run',
      [
        '--user',
        '--collect',
        '--quiet',
        '--unit=phosphor-update-1234.service',
        '--description=Phosphor Host update',
        `--setenv=PHOSPHOR_HOST_RELEASE_URL=${f.context.env.PHOSPHOR_HOST_RELEASE_URL}`,
        '--setenv=PATH=/usr/bin',
        '--setenv=PHOSPHOR_UPDATE_DETACHED=1',
        join(f.old, 'node/bin/node'),
        join(f.old, 'lib/phosphor.mjs'),
        'update',
        '--version',
        '1.2.3',
      ],
    ],
  ])
  expect(f.messages.join('\n')).toContain('journalctl --user -u phosphor-update-1234.service')
  // Nothing was selected or staged here: the detached run does it all.
  expect(readlinkSync(join(f.lib, 'current'))).toBe('versions/1.0.0')
  expect(readdirSync(join(f.lib, 'versions'))).toEqual(['1.0.0'])
})

it('passes --rollback through, and says what to do when systemd-run fails', async () => {
  const { f, calls } = setup()
  f.context.service = {
    runner: async (program, args) => {
      calls.push([program, [...args]])
      return { code: 1, stdout: '' }
    },
  }
  expect(await runUpdate(f.context, { rollback: true })).toBe(69)
  expect(calls[0]?.[1].slice(-2)).toEqual(['update', '--rollback'])
  expect(f.messages.join('\n')).toContain('Run phosphor update over SSH.')
})

it('updates in place for a check, the detached re-run, macOS and an SSH shell', async () => {
  for (const variant of ['check', 'detached', 'darwin', 'ssh'] as const) {
    const { f, calls } = setup(variant === 'ssh' ? '0::/user.slice/session-4.scope\n' : HOST_CGROUP)
    if (variant === 'detached') f.context.env.PHOSPHOR_UPDATE_DETACHED = '1'
    if (variant === 'darwin') f.context.platform = 'darwin'
    await runUpdate(f.context, { check: variant === 'check' })
    expect(calls.some(([program]) => program === 'systemd-run')).toBe(false)
  }
})
