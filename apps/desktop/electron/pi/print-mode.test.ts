import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPrintMode } from './print-mode'

/**
 * The fixture behaves like `pi -p`: it does not answer until stdin reaches
 * EOF. That is the exact behaviour that made `execFile` hang forever and left
 * every session unnamed, and it is why the e2e stub could not catch it — the
 * stub prints and exits without ever looking at stdin.
 */
let dir: string
let blockingScript: string
let failingScript: string
let answersThenHangsScript: string
let leavesChildScript: string
let childPidFile: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'phosphor-print-mode-'))
  blockingScript = join(dir, 'waits-for-stdin.cjs')
  writeFileSync(
    blockingScript,
    [
      'const chunks = []',
      "process.stdin.on('data', (c) => chunks.push(c))",
      "process.stdin.on('end', () => {",
      "  process.stdout.write('Friendly Greeting\\n')",
      '  process.exit(0)',
      '})',
    ].join('\n'),
  )
  // pi-claude-cli >= 0.7.0 parks its CLI child after `result`, so `pi -p`
  // prints a complete answer and then stays alive. Measured on 0.7.0: the
  // title landed at 4.6s, the process was still running at 90s.
  answersThenHangsScript = join(dir, 'answers-then-hangs.cjs')
  writeFileSync(
    answersThenHangsScript,
    ["process.stdout.write('Friendly Greeting\\n')", 'setInterval(() => {}, 1000)'].join('\n'),
  )
  // A provider or extension that starts its own child (the Claude CLI, an
  // MCP server) and exits without stopping it.
  childPidFile = join(dir, 'child.pid')
  leavesChildScript = join(dir, 'leaves-child.cjs')
  writeFileSync(
    leavesChildScript,
    [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
      'child.unref()',
      `writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid))`,
      "process.stdout.write('Friendly Greeting\\n')",
      'process.exit(0)',
    ].join('\n'),
  )
  failingScript = join(dir, 'fails.cjs')
  writeFileSync(failingScript, ["process.stderr.write('nope\\n')", 'process.exit(3)'].join('\n'))
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const run = (script: string, timeoutMs = 5_000): ReturnType<typeof runPrintMode> =>
  runPrintMode(process.execPath, [script], { cwd: dir, env: process.env, timeoutMs })

describe('runPrintMode', () => {
  it('completes a command that waits for stdin EOF', async () => {
    const result = await run(blockingScript)
    expect(result.error).toBeUndefined()
    expect(result.stdout.trim()).toBe('Friendly Greeting')
  })

  it('reports a non-zero exit with its stderr rather than throwing', async () => {
    const result = await run(failingScript)
    expect(result.stdout).toBe('')
    expect(result.error).toContain('exited 3')
    expect(result.error).toContain('nope')
  })

  it('keeps stdout already printed when the run times out', async () => {
    const result = await run(answersThenHangsScript, 1_000)
    // Both set: the answer is usable, and the caller can still see that the
    // process had to be killed. Throwing the title away here is what left
    // three sessions unnamed the day pi-claude-cli 0.7.0 landed.
    expect(result.stdout.trim()).toBe('Friendly Greeting')
    expect(result.error).toContain('timed out')
  })

  it.skipIf(process.platform === 'win32')(
    'leaves nothing behind that the run started',
    async () => {
      const result = await run(leavesChildScript)
      expect(result.stdout.trim()).toBe('Friendly Greeting')
      const pid = Number(readFileSync(childPidFile, 'utf8'))
      const alive = (): boolean => {
        try {
          process.kill(pid, 0)
          return true
        } catch {
          return false
        }
      }
      for (let i = 0; i < 20 && alive(); i++) await new Promise((r) => setTimeout(r, 50))
      expect(alive()).toBe(false)
    },
  )

  it('reports a spawn failure rather than throwing', async () => {
    const result = await runPrintMode(join(dir, 'does-not-exist'), [], {
      cwd: dir,
      env: process.env,
      timeoutMs: 5_000,
    })
    expect(result.stdout).toBe('')
    expect(result.error).toBeTruthy()
  })
})

/**
 * Baseline behaviour pinned before print mode grew cancellation and
 * streaming: what every existing caller (session naming, the usage probe) gets
 * back. A caller that passes no new option must keep seeing exactly this.
 */
describe('runPrintMode baseline', () => {
  const script = (name: string, lines: string[]): string => {
    const path = join(dir, name)
    writeFileSync(path, lines.join('\n'))
    return path
  }
  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const waitForDeath = async (pid: number): Promise<boolean> => {
    for (let i = 0; i < 40 && isAlive(pid); i++) await new Promise((r) => setTimeout(r, 50))
    return !isAlive(pid)
  }

  it('resolves a clean run with its stdout and nothing else', async () => {
    const result = await run(blockingScript)
    expect(result).toEqual({ stdout: 'Friendly Greeting\n' })
  })

  it('treats stderr on a clean exit as noise, not an error', async () => {
    const noisy = script('noisy-ok.cjs', [
      "process.stderr.write('warning: something\\n')",
      "process.stdout.write('ok\\n')",
      'process.exit(0)',
    ])
    expect(await run(noisy)).toEqual({ stdout: 'ok\n' })
  })

  it('drops stdout on a non-zero exit and names the code', async () => {
    const partial = script('partial-then-fails.cjs', [
      "process.stdout.write('partial\\n')",
      'process.exit(2)',
    ])
    expect(await run(partial)).toEqual({ stdout: '', error: 'exited 2' })
  })

  it.skipIf(process.platform === 'win32')(
    'reports a death by signal as an exit with no code',
    async () => {
      const killed = script('kills-itself.cjs', ["process.kill(process.pid, 'SIGKILL')"])
      expect(await run(killed)).toEqual({ stdout: '', error: 'exited null' })
    },
  )

  it.skipIf(process.platform === 'win32')(
    'gives the child /dev/null for stdin, never a pipe',
    async () => {
      const probe = script('stdin-probe.cjs', [
        "const stat = require('node:fs').fstatSync(0)",
        'process.stdout.write(JSON.stringify({ fifo: stat.isFIFO(), char: stat.isCharacterDevice() }))',
      ])
      const result = await run(probe)
      expect(JSON.parse(result.stdout)).toEqual({ fifo: false, char: true })
    },
  )

  it.skipIf(process.platform === 'win32')(
    'runs the child as its own process group leader',
    async () => {
      const probe = script('group-probe.cjs', [
        "const { execSync } = require('node:child_process')",
        "const pgid = execSync('ps -o pgid= -p ' + process.pid).toString().trim()",
        "process.stdout.write(pgid === String(process.pid) ? 'leader' : 'member')",
      ])
      expect(await run(probe)).toEqual({ stdout: 'leader' })
    },
  )

  it.skipIf(process.platform === 'win32')(
    'kills what the run started when it times out',
    async () => {
      const pidFile = join(dir, 'timeout-child.pid')
      const hangsWithChild = script('hangs-with-child.cjs', [
        "const { spawn } = require('node:child_process')",
        "const { writeFileSync } = require('node:fs')",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
        `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))`,
        "process.stdout.write('answer\\n')",
        'setInterval(() => {}, 1000)',
      ])
      const result = await run(hangsWithChild, 1_000)
      expect(result).toEqual({ stdout: 'answer\n', error: 'timed out after 1000ms' })
      expect(await waitForDeath(Number(readFileSync(pidFile, 'utf8')))).toBe(true)
    },
  )

  it('stops collecting stdout past about a mebibyte', async () => {
    const flood = script('floods-stdout.cjs', [
      "const chunk = 'x'.repeat(64 * 1024)",
      'for (let i = 0; i < 64; i++) process.stdout.write(chunk)',
    ])
    const result = await run(flood)
    expect(result.error).toBeUndefined()
    expect(result.stdout.length).toBeGreaterThanOrEqual(1024 * 1024)
    expect(result.stdout.length).toBeLessThan(2 * 1024 * 1024)
  })

  it('stops collecting stderr past about a mebibyte', async () => {
    const flood = script('floods-stderr.cjs', [
      "const chunk = 'e'.repeat(64 * 1024)",
      'for (let i = 0; i < 64; i++) process.stderr.write(chunk)',
      'process.exitCode = 1',
    ])
    const result = await run(flood)
    expect(result.stdout).toBe('')
    expect(result.error?.startsWith('exited 1: eee')).toBe(true)
    expect(result.error!.length).toBeLessThan(2 * 1024 * 1024)
  })

  it('settles once with the spawn error when a missing binary also closes', async () => {
    const result = await runPrintMode(join(dir, 'missing-binary'), [], {
      cwd: dir,
      env: process.env,
      timeoutMs: 5_000,
    })
    expect(result).toEqual({ stdout: '', error: expect.stringContaining('ENOENT') })
    expect(result.error).not.toContain('exited')
  })

  it('reports an argument spawn() rejects outright as a spawn failure', async () => {
    const result = await runPrintMode('bad\0binary', [], {
      cwd: dir,
      env: process.env,
      timeoutMs: 5_000,
    })
    expect(result.stdout).toBe('')
    expect(result.error).toMatch(/^spawn failed: /)
  })

  it('gives up after 30 seconds when the caller names no timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      let settled = false
      const pending = runPrintMode(process.execPath, [answersThenHangsScript], {
        cwd: dir,
        env: process.env,
      }).then((result) => {
        settled = true
        return result
      })
      await vi.advanceTimersByTimeAsync(29_999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      const result = await pending
      expect(result.error).toBe('timed out after 30000ms')
    } finally {
      vi.useRealTimers()
    }
  })
})
