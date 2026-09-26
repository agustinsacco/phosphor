import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({
  checked: false,
  isChecked: vi.fn(),
  log: vi.fn(),
}))
vi.mock('../store', () => ({
  isCompactionResetChecked: state.isChecked,
  markCompactionResetChecked: () => {
    state.checked = true
  },
}))
vi.mock('../debug-log', () => ({ log: state.log }))
import { resetLeftoverCompaction } from './compaction-reset'

let dir: string
let previousEnv: string | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'phosphor-compaction-'))
  previousEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = dir
  state.checked = false
  state.isChecked.mockReset().mockImplementation(() => state.checked)
  state.log.mockReset()
})

afterEach(async () => {
  if (previousEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = previousEnv
  await rm(dir, { recursive: true, force: true })
})

const settingsPath = (): string => join(dir, 'settings.json')
const marker = (done = false) => ({ done: () => done, markDone: vi.fn() })

describe('resetLeftoverCompaction', () => {
  it('turns a leftover false back on and keeps everything else', async () => {
    await writeFile(
      settingsPath(),
      JSON.stringify({
        defaultProvider: 'pi-claude-cli',
        packages: ['npm:@saccolabs/pi-claude-cli'],
        compaction: { enabled: false, reserveTokens: 20_000 },
      }),
    )
    const m = marker()
    expect(await resetLeftoverCompaction(m)).toBe('reset')
    expect(JSON.parse(await readFile(settingsPath(), 'utf8'))).toEqual({
      defaultProvider: 'pi-claude-cli',
      packages: ['npm:@saccolabs/pi-claude-cli'],
      compaction: { enabled: true, reserveTokens: 20_000 },
    })
    expect(m.markDone).toHaveBeenCalledOnce()
  })

  it.each([
    ['on', { compaction: { enabled: true } }],
    ['unset', { compaction: { reserveTokens: 20_000 } }],
    ['absent', { defaultProvider: 'openai-codex' }],
  ])('leaves compaction that is %s untouched, and records the check', async (_label, settings) => {
    const raw = JSON.stringify(settings)
    await writeFile(settingsPath(), raw)
    const m = marker()
    expect(await resetLeftoverCompaction(m)).toBe('unchanged')
    expect(await readFile(settingsPath(), 'utf8')).toBe(raw)
    expect(m.markDone).toHaveBeenCalledOnce()
  })

  it('does not create a settings file that is not there', async () => {
    const m = marker()
    expect(await resetLeftoverCompaction(m)).toBe('unchanged')
    await expect(readFile(settingsPath(), 'utf8')).rejects.toThrow('ENOENT')
    expect(m.markDone).toHaveBeenCalledOnce()
  })

  it('never touches a false set after the check has run', async () => {
    const raw = JSON.stringify({ compaction: { enabled: false } })
    await writeFile(settingsPath(), raw)
    const m = marker(true)
    expect(await resetLeftoverCompaction(m)).toBe('already-checked')
    expect(await readFile(settingsPath(), 'utf8')).toBe(raw)
    expect(m.markDone).not.toHaveBeenCalled()
  })

  it('leaves a malformed file alone and unmarked, to check again', async () => {
    const raw = '{ "compaction": { "enabled": false }, '
    await writeFile(settingsPath(), raw)
    const m = marker()
    await expect(resetLeftoverCompaction(m)).rejects.toThrow('not valid JSON')
    expect(await readFile(settingsPath(), 'utf8')).toBe(raw)
    expect(m.markDone).not.toHaveBeenCalled()
  })
})

describe('ensureCompactionReset', () => {
  // `once` is module state: every test needs its own copy of the module.
  const fresh = async () => {
    vi.resetModules()
    return (await import('./compaction-reset')).ensureCompactionReset
  }

  it('runs the check once however many spawns ask for it', async () => {
    await writeFile(settingsPath(), JSON.stringify({ compaction: { enabled: false } }))
    const ensure = await fresh()
    await Promise.all([ensure(), ensure(), ensure()])
    await ensure()
    expect(state.isChecked).toHaveBeenCalledOnce()
    expect(state.checked).toBe(true)
    expect(JSON.parse(await readFile(settingsPath(), 'utf8'))).toEqual({
      compaction: { enabled: true },
    })
    expect(state.log).toHaveBeenCalledWith(
      'pi',
      'turned pi auto-compaction back on (left off by an older Phosphor)',
    )
  })

  it('resolves on failure, so a spawn is never blocked by it', async () => {
    await writeFile(settingsPath(), '{')
    const ensure = await fresh()
    await expect(ensure()).resolves.toBeUndefined()
    expect(state.checked).toBe(false)
    expect(state.log).toHaveBeenCalledWith('pi', 'compaction reset skipped', {
      error: expect.stringContaining('not valid JSON'),
    })
  })
})
