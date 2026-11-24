import { expect, it } from 'vitest'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { piCheck, realPiFence } from './real-pi.mjs'

it('passes only a setup that exits 0 with its pi check passing, and hides paths', () => {
  const report = (exitCode, status, summary) =>
    JSON.stringify({ exitCode, checks: [{ id: 'pi', status, summary }], notes: [] })
  expect(piCheck(report(0, 'pass', '/Users/me/.pi/agent/bin/pi 1.5.2'))).toEqual({
    status: 'pass',
    summary: '<path> 1.5.2',
  })
  // This Mac's first setup on 0.2.92.
  expect(
    piCheck(report(69, 'fail', '/Users/me/.pi/agent/bin/pi --version failed (exit 127): env')),
  ).toEqual({ status: 'fail', summary: '<path> --version failed (exit 127): env' })
  expect(
    piCheck(JSON.stringify({ exitCode: 69, checks: [], notes: ['install pi first'] })),
  ).toEqual({ status: 'fail', summary: 'install pi first' })
  expect(piCheck('')).toEqual({ status: 'fail', summary: 'setup printed no report' })
})

it.skipIf(process.platform !== 'darwin')(
  'fences writes under HOME outside scratch, and launchctl',
  () => {
    const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'r0-home-'))),
      root = join(home, 'scratch')
    mkdirSync(root)
    try {
      const run = (program, args) =>
        spawnSync('/usr/bin/sandbox-exec', [...realPiFence(home, root), program, ...args], {
          stdio: 'ignore',
          timeout: 5000,
        }).status
      expect(run('/usr/bin/touch', [join(root, 'allowed')])).toBe(0)
      expect(run('/usr/bin/touch', [join(home, 'denied')])).not.toBe(0)
      expect(existsSync(join(home, 'denied'))).toBe(false)
      expect(run('/bin/launchctl', ['version'])).not.toBe(0)
    } finally {
      rmSync(home, { recursive: true })
    }
  },
)
