import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RawPrefs } from '../prefs-migrations'
import { migrateRetiredDirectives } from './retired-directives'

let agentDir: string
beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), 'retired-directives-'))
})
afterEach(() => rmSync(agentDir, { recursive: true, force: true }))

function raw(data: Record<string, unknown>): RawPrefs & { data: Record<string, unknown> } {
  return {
    data,
    get: (key) => data[key],
    set: (key, value) => {
      data[key] = value
    },
    delete: (key) => {
      delete data[key]
    },
  }
}
const ON = { machineAwareness: true, worktreeGuard: true, laneCharter: true, subagentPolicy: true }

it('appends the global text to AGENTS.md once and keeps project text for Settings', () => {
  writeFileSync(join(agentDir, 'AGENTS.md'), '# Already here\n')
  const prefs = raw({
    agentDirectives: { ...ON, custom: '  Prefer small PRs.  ' },
    agentDirectivesByProject: {
      '/repo/a': { ...ON, laneCharter: false, custom: 'Run make check.' },
      '/repo/b': { ...ON, custom: '' },
      '/repo/c': { ...ON },
    },
  })
  const log = vi.fn()
  migrateRetiredDirectives(prefs, agentDir, log)
  expect(readFileSync(join(agentDir, 'AGENTS.md'), 'utf8')).toBe(
    '# Already here\n\nPrefer small PRs.\n',
  )
  expect(prefs.data).toEqual({
    agentDirectives: ON,
    agentDirectivesByProject: {
      '/repo/a': { ...ON, laneCharter: false },
      '/repo/b': ON,
      '/repo/c': ON,
    },
    retiredDirectives: { '/repo/a': 'Run make check.' },
  })
  expect(log).toHaveBeenCalledWith(expect.stringContaining('moved'), expect.anything())
  migrateRetiredDirectives(prefs, agentDir)
  expect(readFileSync(join(agentDir, 'AGENTS.md'), 'utf8')).toBe(
    '# Already here\n\nPrefer small PRs.\n',
  )
})

it('drops project text that repeats the global text already moved', () => {
  const prefs = raw({
    agentDirectives: { ...ON, custom: 'Same words.' },
    agentDirectivesByProject: { '/repo': { ...ON, custom: 'Same words.' } },
  })
  migrateRetiredDirectives(prefs, agentDir)
  expect(readFileSync(join(agentDir, 'AGENTS.md'), 'utf8')).toBe('Same words.\n')
  expect(prefs.data.retiredDirectives).toBeUndefined()
})

it('keeps the global text for Settings when the file cannot take it', () => {
  writeFileSync(join(agentDir, 'AGENTS.md'), 'x\0y')
  const prefs = raw({ agentDirectives: { ...ON, custom: 'Keep me.' } })
  migrateRetiredDirectives(prefs, agentDir)
  expect(prefs.data.retiredDirectives).toEqual({ '': 'Keep me.' })
  expect(prefs.data.agentDirectives).toEqual(ON)
})

it('changes nothing for prefs that never had free text', () => {
  const prefs = raw({ agentDirectives: ON, agentDirectivesByProject: { '/repo': ON } })
  const set = vi.spyOn(prefs, 'set')
  migrateRetiredDirectives(prefs, agentDir)
  expect(set).not.toHaveBeenCalled()
})
