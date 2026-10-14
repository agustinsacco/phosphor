import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { terminalState } from './state'
import { loadHostPty } from './native'

it('loads native code only from the fixed resource tree, never the installed Desktop dependency', () => {
  expect(loadHostPty()).toBeNull()
})
it('bounds durable state, refuses symlinks and does not store scrollback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-state-'))
  try {
    const state = terminalState(dir)
    expect(state.load()).toEqual([])
    state.save([])
    expect(state.load()).toEqual([])
    const file = join(dir, 'terminals.json')
    writeFileSync(file, ' '.repeat(8190) + '[]')
    expect(state.load()).toEqual([])
    writeFileSync(file, ' '.repeat(8191) + '[]')
    expect(() => state.load()).toThrow('Invalid terminal state')
    rmSync(file)
    writeFileSync(join(dir, 'other'), '[]')
    symlinkSync(join(dir, 'other'), file)
    expect(() => state.load()).toThrow('Terminal state unavailable')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
