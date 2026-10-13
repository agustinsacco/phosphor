import { afterEach, expect, it } from 'vitest'
import { runCli } from './cli'
import { bundle, fixture } from './update/__fixtures__/release'
const fixtures: ReturnType<typeof fixture>[] = []
function setup() {
  const f = fixture()
  fixtures.push(f)
  return f
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup()
})
it.each([
  ['update', '--version', '../x'],
  ['update', '--version', '01.2.3'],
  ['update', '--rollback', '--check'],
  ['update', '--rollback', '--version', '1.2.3'],
  ['update', '--local'],
  ['update', 'extra'],
  ['uninstall', '--purge'],
  ['uninstall', '--yes'],
  ['uninstall', '--version', '1.2.3'],
  ['uninstall', 'extra'],
])('refuses invalid install CLI arguments %j', async (...argv) => {
  const f = setup(),
    stderr: string[] = []
  expect(
    await runCli(
      argv,
      { stdout: () => {}, stderr: (line) => stderr.push(line) },
      { ...f.context, nodeVersion: process.versions.node, defaultResourceRoot: '/unused' },
    ),
  ).toBe(64)
  expect(stderr.join('')).toContain('usage:')
})
it('dispatches update check with JSON and offline rollback, and exposes help', async () => {
  const f = setup(),
    stdout: string[] = []
  f.release()
  const context = {
    ...f.context,
    nodeVersion: process.versions.node,
    defaultResourceRoot: '/unused',
  }
  const io = { stdout: (line: string) => stdout.push(line), stderr: () => {} }
  expect(await runCli(['update', '--check', '--json'], io, context)).toBe(0)
  expect(JSON.parse(stdout.pop() ?? '')).toEqual({
    exitCode: 0,
    messages: ['Installed: 1.0.0; available: 1.2.3'],
  })
  f.release('1.2.3', bundle(), (m) => {
    m.protocols = [2]
  })
  expect(await runCli(['update', '--check', '--json'], io, context)).toBe(0)
  expect(JSON.parse(stdout.pop() ?? '')).toEqual({
    exitCode: 0,
    messages: [
      'Installed: 1.0.0; available: 1.2.3',
      'This release speaks a newer Host protocol: apps that have not updated cannot connect.',
    ],
  })
  expect(await runCli(['update', '--rollback', '--json'], io, context)).toBe(75)
  expect(JSON.parse(stdout.pop() ?? '').exitCode).toBe(75)
  expect(await runCli(['help'], io, context)).toBe(0)
  expect(stdout.pop()).toContain('uninstall [--purge --yes]')
})
it('dispatches uninstall with a JSON report', async () => {
  const f = setup(),
    stdout: string[] = []
  expect(
    await runCli(
      ['uninstall', '--json'],
      { stdout: (line) => stdout.push(line), stderr: () => {} },
      { ...f.context, nodeVersion: process.versions.node, defaultResourceRoot: '/unused' },
    ),
  ).toBe(0)
  expect(JSON.parse(stdout[0] ?? '').exitCode).toBe(0)
})
