import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runGroup } from './process-group.mjs'

// A test that hangs: it starts a grandchild in its own group, records both
// pids, and never exits. Neither process reads stdin or writes output.
const STALL = `
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
writeFileSync(process.argv[1], JSON.stringify([process.pid, grandchild.pid]))
setInterval(() => {}, 1000)
`

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

let dir: string
let pidsFile: string
const pids = (): number[] => JSON.parse(readFileSync(pidsFile, 'utf8')) as number[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'phosphor-process-group-'))
  pidsFile = join(dir, 'pids.json')
})

afterEach(() => {
  // A failed assertion must not leave the stall running.
  if (existsSync(pidsFile)) {
    for (const pid of pids()) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Gone, as it should be.
      }
    }
  }
  rmSync(dir, { recursive: true, force: true })
})

const stall = (options: { timeoutMs: number; signal?: AbortSignal }) =>
  runGroup(process.execPath, ['-e', STALL, pidsFile], { ...options, env: process.env })

describe('runGroup', () => {
  it('resolves with the exit code', async () => {
    const code = runGroup(process.execPath, ['-e', 'process.exit(3)'], { timeoutMs: 10_000 })
    expect(await code).toBe(3)
  })

  it('kills the whole group, grandchildren too, when cancelled', { timeout: 20_000 }, async () => {
    const cancel = new AbortController()
    const run = stall({ timeoutMs: 60_000, signal: cancel.signal })
    await vi.waitFor(() => expect(existsSync(pidsFile)).toBe(true), { timeout: 10_000 })
    const [child, grandchild] = pids()
    expect(alive(child!) && alive(grandchild!)).toBe(true)
    cancel.abort()
    expect(await run).toBeNull()
    await vi.waitFor(() => expect(alive(grandchild!)).toBe(false), { timeout: 10_000 })
  })

  it('kills a group that outlives its deadline', { timeout: 20_000 }, async () => {
    const run = stall({ timeoutMs: 3_000 })
    expect(await run).toBeNull()
    const [, grandchild] = pids()
    await vi.waitFor(() => expect(alive(grandchild!)).toBe(false), { timeout: 10_000 })
  })

  it('starts nothing once already cancelled', async () => {
    const cancel = new AbortController()
    cancel.abort()
    expect(await stall({ timeoutMs: 60_000, signal: cancel.signal })).toBeNull()
    expect(existsSync(pidsFile)).toBe(false)
  })
})
