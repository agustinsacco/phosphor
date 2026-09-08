import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
