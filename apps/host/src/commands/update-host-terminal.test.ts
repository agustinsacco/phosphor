import { mkdirSync, readFileSync, readlinkSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { fixture } from '../update/__fixtures__/release'
import { HANDOFF_FAILED, UPDATE_UNIT, insideHostUnit } from '../update/handoff'
import type { Drainable } from '../shutdown'
import { runCli } from '../cli'
import { runUpdate } from './update'

/**
 * `phosphor update` typed into a Host terminal (the command the Machines page
 * offers to copy) runs inside the systemd unit it restarts. The restart then
 * stopped the updater along with the Host, and the stopped updater rolled the
 * new release back: the Host stayed on the old version, without the newer
 * calls (plan usage) its apps asked it for.
 */
const HOST_CGROUP =
  '0::/user.slice/user-1000.slice/user@1000.service/app.slice/phosphor-host.service\n'

const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup()
})

/** `phosphor update …` through the real dispatch; returns the exit code and printed lines. */
async function cli(f: ReturnType<typeof fixture>, argv: string[]) {
  const stdout: string[] = []
  const code = await runCli(
    ['update', ...argv],
    { stdout: (text) => stdout.push(text), stderr: () => {} },
    { ...f.context, nodeVersion: process.versions.node, defaultResourceRoot: '/unused' },
  )
  return { code, lines: stdout.join('').split('\n').filter(Boolean) }
}

function setup(cgroup: string) {
  const f = fixture()
  fixtures.push(f)
  f.release()
  f.context.update = { ...f.context.update, cgroup: () => cgroup }
  const unit = join(f.home, '.config/systemd/user/phosphor-host.service')
  mkdirSync(join(unit, '..'), { recursive: true })
  writeFileSync(unit, 'unit')
  const calls: { program: string; args: readonly string[] }[] = []
  return { f, calls }
}

it('reads the Host unit from cgroup v2 and v1 paths, and nothing else', () => {
  expect(insideHostUnit(() => HOST_CGROUP)).toBe(true)
  expect(
    insideHostUnit(
      () => '12:pids:/x\n1:name=systemd:/user.slice/app.slice/phosphor-host.service\n',
    ),
  ).toBe(true)
  expect(insideHostUnit(() => '0::/user.slice/app.slice/phosphor-host-update.service\n')).toBe(
    false,
  )
  expect(insideHostUnit(() => '0::/user.slice/user-1000.slice/session-3.scope\n')).toBe(false)
  expect(
    insideHostUnit(() => {
      throw new Error('no /proc')
    }),
  ).toBe(false)
})

it.each([[[]], [['--version', '1.2.3']], [['--rollback']]])(
  'hands update %j from inside the Host unit to a transient unit before touching the install',
  async (extra) => {
    const { f, calls } = setup(HOST_CGROUP)
    f.context.env = { ...f.context.env, HOME: f.home, SECRET_TOKEN: 'never passed' }
    f.context.service = {
      runner: async (program, args) => {
        calls.push({ program, args })
        return { code: 0, stdout: '' }
      },
    }
    const { code, lines } = await cli(f, extra)
    expect(code).toBe(0)
    const version = join(f.lib, 'versions/1.0.0')
    expect(calls).toEqual([
      {
        program: 'systemd-run',
        args: [
          '--user',
          `--unit=${UPDATE_UNIT}`,
          '--collect',
          '--quiet',
          `--setenv=HOME=${f.home}`,
          `--setenv=PHOSPHOR_HOST_RELEASE_URL=${f.context.env.PHOSPHOR_HOST_RELEASE_URL}`,
          '--',
          join(version, 'node/bin/node'),
          join(version, 'lib/phosphor.mjs'),
          'update',
          ...extra,
        ],
      },
    ])
    expect(readlinkSync(join(f.lib, 'current'))).toBe('versions/1.0.0')
    expect(readdirSync(join(f.lib, 'versions'))).toEqual(['1.0.0'])
    expect(lines).toContain(`Follow it with: journalctl --user -u ${UPDATE_UNIT}`)
  },
)

it('keeps --check in the terminal: it restarts nothing', async () => {
  const { f, calls } = setup(HOST_CGROUP)
  f.context.service = {
    runner: async (program, args) => {
      calls.push({ program, args })
      return { code: 0, stdout: '' }
    },
  }
  expect(await cli(f, ['--check'])).toEqual({
    code: 0,
    lines: ['Installed: 1.0.0; available: 1.2.3'],
  })
  expect(calls).toEqual([])
})

it('changes nothing and says where to run it when systemd-run fails', async () => {
  const { f } = setup(HOST_CGROUP)
  f.context.service = { runner: async () => ({ code: 1, stdout: '' }) }
  expect(await cli(f, ['--json'])).toEqual({
    code: 75,
    lines: [JSON.stringify({ exitCode: 75, messages: [HANDOFF_FAILED] })],
  })
  expect(readlinkSync(join(f.lib, 'current'))).toBe('versions/1.0.0')
  expect(readdirSync(join(f.lib, 'versions'))).toEqual(['1.0.0'])
})

it('updates in place outside the Host unit', async () => {
  const { f, calls } = setup('0::/user.slice/user-1000.slice/session-3.scope\n')
  f.context.service = {
    runner: async (program, args) => {
      calls.push({ program, args })
      return { code: 3, stdout: '' }
    },
  }
  expect((await cli(f, [])).code).toBe(0)
  expect(calls.map((c) => c.program)).toEqual(['systemctl'])
  expect(readlinkSync(join(f.lib, 'current'))).toBe('versions/1.2.3')
})

it('does not roll back when a signal ends the updater during the service restart', async () => {
  // What a restart does to an updater that is still inside the unit: systemctl and the
  // updater both get the stop's SIGTERM. The restart itself completes on whatever
  // `current` names, so a rollback here would start the old release.
  const { f } = setup('0::/user.slice/user-1000.slice/session-3.scope\n')
  let target: Drainable | undefined
  f.context.attach = (t) => {
    target = t
    return () => {}
  }
  let restarts = 0
  f.context.service = {
    runner: async (_program, args) => {
      if (args.includes('is-active')) return { code: 0, stdout: '' }
      if (args.includes('restart')) {
        restarts++
        void target?.drain('SIGTERM')
        return { code: null, stdout: '' }
      }
      return { code: 0, stdout: '' }
    },
  }
  expect(await runUpdate(f.context)).toBe(143)
  expect(restarts).toBe(1)
  expect(readlinkSync(join(f.lib, 'current'))).toBe('versions/1.2.3')
  expect(JSON.parse(readFileSync(join(f.lib, 'install.json'), 'utf8'))).toEqual({
    current: '1.2.3',
    previous: '1.0.0',
  })
})
