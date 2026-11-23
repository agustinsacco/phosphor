import { readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { runCli } from '../cli'
import { fixture } from './__fixtures__/release'
import { hostUpdateProgram } from './handoff'

/** Tests only: the one-shot job's label, so nothing here can name the real updater job. */
const LABEL = 'com.saccolabs.phosphor-spike.d4-update'

const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup()
})

function darwin() {
  const f = fixture()
  fixtures.push(f)
  f.context.platform = 'darwin'
  f.context.arch = 'arm64'
  f.context.update = { ...f.context.update, jobLabel: LABEL }
  return f
}

it('R5: the macOS host.update task runs the installed updater and names the service pid', () => {
  const f = darwin()
  const { node, bundle } = f.context.update!
  const version = join(f.lib, 'versions/1.0.0')
  const env = { HOME: f.home, PATH: '/usr/bin', SECRET_TOKEN: 'never passed' }
  expect(hostUpdateProgram(f.home, env, 'darwin', node, bundle, 4242)).toEqual({
    node: join(version, 'node/bin/node'),
    bundle: join(version, 'lib/phosphor.mjs'),
    env: { PHOSPHOR_HOST_PID: '4242' },
  })
})

it('R5: hands an update from inside the service to a one-shot launchd job under the state folder', async () => {
  const f = darwin()
  const uid = f.context.uid
  f.context.env = {
    ...f.context.env,
    HOME: f.home,
    PATH: '/usr/bin:/bin',
    PHOSPHOR_HOST_PID: '4242',
    SECRET_TOKEN: 'never passed',
  }
  const calls: [string, readonly string[]][] = []
  f.context.service = {
    runner: async (program, args) => {
      calls.push([program, args])
      if (args[0] === 'print') return { code: 0, stdout: 'state = running\npid = 4242\n' }
      if (args[0] === 'bootout') return { code: 3, stdout: '' }
      return { code: 0, stdout: '' }
    },
  }
  const stdout: string[] = []
  const code = await runCli(
    ['update', '--version', '1.2.3'],
    { stdout: (text) => stdout.push(text), stderr: () => {} },
    { ...f.context, nodeVersion: process.versions.node, defaultResourceRoot: '/unused' },
  )
  expect(code).toBe(0)
  const plist = join(f.home, '.local/state/phosphor-host/update', `${LABEL}.plist`)
  expect(calls).toEqual([
    ['launchctl', ['print', `gui/${uid}/com.saccolabs.phosphor-host`]],
    ['launchctl', ['bootout', `gui/${uid}/${LABEL}`]],
    ['launchctl', ['bootstrap', `gui/${uid}`, plist]],
  ])
  const text = readFileSync(plist, 'utf8')
  const version = join(f.lib, 'versions/1.0.0')
  expect(text).toContain(`<key>Label</key><string>${LABEL}</string>`)
  expect(text).toContain(
    `<key>ProgramArguments</key><array><string>${join(version, 'node/bin/node')}</string><string>${join(version, 'lib/phosphor.mjs')}</string><string>update</string><string>--version</string><string>1.2.3</string></array>`,
  )
  expect(text).toContain('<key>RunAtLoad</key><true/>')
  expect(text).not.toContain('KeepAlive')
  expect(text).toContain(`<key>HOME</key><string>${f.home}</string>`)
  expect(text).toContain('<key>PATH</key><string>/usr/bin:/bin</string>')
  expect(text).not.toContain('SECRET_TOKEN')
  expect(text).not.toContain('PHOSPHOR_HOST_PID')
  expect(readlinkSync(join(f.lib, 'current'))).toBe('versions/1.0.0')
})
