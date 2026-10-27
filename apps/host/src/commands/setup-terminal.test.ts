import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { setupTerminal, type TerminalScreen } from './setup-terminal'

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

function recordingScreen() {
  const lines: string[] = []
  const done = vi.fn()
  const screen: TerminalScreen = {
    ask: vi.fn(async () => true),
    task: vi.fn(() => ({ line: (text: string) => void lines.push(text), done })),
    handOver: vi.fn(),
  }
  return { screen, lines, done }
}

it("shows a task's output as the screen's log, with how it ended", async () => {
  const { screen, lines, done } = recordingScreen()
  const terminal = setupTerminal(process.env, undefined, 1, screen)
  const script = "console.log('one'); console.error('two'); process.exit(3)"
  expect(await terminal.run(process.execPath, ['-e', script], 'task')).toBe(3)
  expect(screen.task).toHaveBeenCalledWith(`node -e ${script}`)
  expect(lines.join('')).toMatch(/one\n[\s\S]*two\n|two\n[\s\S]*one\n/)
  expect(done).toHaveBeenCalledWith('failed (exit 3)', false)
  expect(screen.handOver).not.toHaveBeenCalled()
})

it('hands the terminal over for an interactive child, and asks through the screen', async () => {
  const { screen } = recordingScreen()
  const terminal = setupTerminal(process.env, undefined, 2, screen)
  expect(await terminal.run(process.execPath, ['-e', 'process.exit(0)'])).toBe(0)
  expect(screen.handOver).toHaveBeenCalledOnce()
  expect(screen.task).not.toHaveBeenCalled()
  expect(await terminal.confirm('Go?', 'cmd')).toBe(true)
  expect(screen.ask).toHaveBeenCalledWith('Go?', undefined)
})
