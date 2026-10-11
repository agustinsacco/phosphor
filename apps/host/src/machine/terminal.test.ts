import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Drainable } from '../shutdown'
import { runInTerminal } from './terminal'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'phosphor-terminal-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function script(name: string, body: string): string {
  const file = join(dir, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return file
}

const env = { PATH: '/usr/bin:/bin' }

describe('runInTerminal', () => {
  it('runs in the folder and environment given, and resolves with the exit code', async () => {
    const out = join(dir, 'seen')
    // HOME is set in this process: it must not reach the program.
    const file = script(
      'login',
      `pwd > '${out}'; echo "$ONLY" >> '${out}'; echo "\${HOME-unset}" >> '${out}'; exit 3`,
    )
    const work = mkdtempSync(join(dir, 'work-'))
    expect(await runInTerminal(file, [], { cwd: work, env: { ...env, ONLY: 'this' } })).toEqual({
      code: 3,
    })
    expect(process.env.HOME).toBeTruthy()
    expect(readFileSync(out, 'utf8')).toBe(`${work}\nthis\nunset\n`)
  })

  it('reports a program that cannot start', async () => {
    const result = await runInTerminal(join(dir, 'missing'), [], { cwd: dir, env })
    expect(result.code).toBeNull()
    expect(result.error).toContain('ENOENT')
  })

  it('is stopped by a signal to the Host, and detached once it has exited', async () => {
    const detach = vi.fn()
    let target: Drainable | undefined
    const run = runInTerminal(script('slow', 'exec sleep 30'), [], {
      cwd: dir,
      env,
      attach: (drainable) => {
        target = drainable
        return detach
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    const started = Date.now()
    expect(await target!.drain('SIGHUP')).toEqual({ state: 'stopped' })
    expect(Date.now() - started).toBeLessThan(1_500)
    expect(await run).toEqual({ code: null })
    expect(detach).toHaveBeenCalledOnce()
  })

  it('kills at once on a second signal, when the first is ignored', async () => {
    let target: Drainable | undefined
    const ready = join(dir, 'ready')
    const file = script('stubborn', `trap '' TERM; touch '${ready}'; while :; do sleep 0.1; done`)
    const run = runInTerminal(file, [], {
      cwd: dir,
      env,
      attach: (drainable) => {
        target = drainable
        return () => {}
      },
    })
    while (!existsSync(ready)) await new Promise((resolve) => setTimeout(resolve, 20))
    const started = Date.now()
    const first = target!.drain('SIGTERM')
    const second = target!.drain('SIGTERM')
    expect(await second).toEqual({ state: 'stopped' })
    expect(await first).toEqual({ state: 'stopped' })
    // Well inside the 2 s grace the first signal alone would wait.
    expect(Date.now() - started).toBeLessThan(1_500)
    expect(await run).toEqual({ code: null })
  })
})
