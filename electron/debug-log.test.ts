import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as DebugLogModule from './debug-log'

// `app.getPath('logs')` is the only Electron surface debug-log touches, and it
// must resolve per-test so a run never writes into the developer's real logs.
let logsDir = ''
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name !== 'logs') throw new Error(`unexpected getPath(${name})`)
      return logsDir
    },
    getVersion: () => '0.0.0-test',
    isPackaged: false,
  },
}))

type DebugLog = typeof DebugLogModule

async function freshModule(): Promise<DebugLog> {
  // Module-level state (the resolved path) must not leak between tests.
  vi.resetModules()
  return import('./debug-log')
}

describe('debug-log', () => {
  beforeEach(() => {
    logsDir = mkdtempSync(join(tmpdir(), 'phosphor-log-test-'))
  })
  afterEach(() => {
    rmSync(logsDir, { recursive: true, force: true })
  })

  it('writes a session header naming PATH, the field that explains a missing binary', async () => {
    const { initDebugLog, debugLogPath } = await freshModule()
    initDebugLog()
    const path = debugLogPath()
    expect(path).toBe(join(logsDir, 'phosphor.log'))
    const body = readFileSync(path!, 'utf8')
    expect(body).toContain('session start')
    expect(body).toContain('"path"')
  })

  it('appends one timestamped line per call, with the scope and payload', async () => {
    const { initDebugLog, log } = await freshModule()
    initDebugLog()
    log('pi', 'spawn', { args: ['--mode', 'rpc'] })
    const lines = readFileSync(join(logsDir, 'phosphor.log'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2) // header + this line
    expect(lines[1]).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z \[pi] spawn /)
    expect(lines[1]).toContain('"--mode"')
  })

  it('is a silent no-op before init, so an early call cannot throw', async () => {
    const { log, debugLogPath } = await freshModule()
    expect(() => log('pi', 'too early')).not.toThrow()
    expect(debugLogPath()).toBeNull()
  })

  it('never throws on an unserializable payload', async () => {
    const { initDebugLog, log } = await freshModule()
    initDebugLog()
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => log('pi', 'circular', circular)).not.toThrow()
    expect(readFileSync(join(logsDir, 'phosphor.log'), 'utf8')).toContain('[unserializable]')
  })

  it('rotates once past the size cap, so the log cannot grow without bound', async () => {
    const { initDebugLog, log } = await freshModule()
    initDebugLog()
    const path = join(logsDir, 'phosphor.log')
    writeFileSync(path, 'x'.repeat(5 * 1024 * 1024 + 1))
    log('pi', 'after rotation')
    expect(existsSync(`${path}.1`)).toBe(true)
    // The new file holds only the post-rotation line, not the old bulk.
    const body = readFileSync(path, 'utf8')
    expect(body).toContain('after rotation')
    expect(body.length).toBeLessThan(1000)
  })
})
