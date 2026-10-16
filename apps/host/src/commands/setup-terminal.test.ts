import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { setupTerminal } from './setup-terminal'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

it('kills a cancelled child that ignores SIGTERM and settles only after it exits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phosphor-terminal-'))
  dirs.push(dir)
  const pidFile = join(dir, 'pid')
  const script = [
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
    "process.on('SIGTERM', () => {})",
    'setInterval(() => {}, 1000)',
  ].join(';')
  const controller = new AbortController()
  const running = setupTerminal(process.env, controller.signal, 2).run(process.execPath, [
    '-e',
    script,
  ])
  for (let i = 0; i < 100 && !readFileSync(pidFile, { flag: 'a+' }).length; i++)
    await new Promise((resolve) => setTimeout(resolve, 50))
  const pid = Number(readFileSync(pidFile, 'utf8'))
  controller.abort()
  expect(await running).toBe(130)
  expect(() => process.kill(pid, 0)).toThrow()
}, 20_000)
