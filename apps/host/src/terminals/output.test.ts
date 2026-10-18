import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { TERMINAL_LIMITS as L, type TerminalFrame } from '@phosphor/shared/host-protocol-terminals'
import { createEntry, createTerminalState } from './service-state'
import { emit, output } from './output'

function setup() {
  const state = createTerminalState({
    native: {
      spawn() {
        throw new Error('unused')
      },
    },
    context: {
      store: { getLane: () => null, listRepositories: () => [] },
      env: {},
      home: '/',
      log() {},
    },
    env: {},
    epoch: 'a'.repeat(16),
    load: () => [],
    save() {},
  })
  const entry = createEntry({ terminalId: randomUUID(), laneId: randomUUID(), status: 'running' })
  return { state, entry }
}
describe('terminal output', () => {
  it('splits mixed Unicode at codepoint boundaries and emits increasing sequences', () => {
    const { state, entry } = setup()
    const frames: TerminalFrame[] = []
    entry.listeners.add((frame) => frames.push(frame))
    output(state, entry, 'a'.repeat(L.chunkBytes - 1) + '💡é')
    expect(entry.chunks).toEqual([
      { seq: 1, data: 'a'.repeat(L.chunkBytes - 1), bytes: L.chunkBytes - 1 },
      { seq: 2, data: '💡é', bytes: 6 },
    ])
    expect(frames).toMatchObject([
      { seq: 1, type: 'terminal.output' },
      { seq: 2, type: 'terminal.output', data: '💡é' },
    ])
  })
  it('evicts whole chunks at the byte and count caps', () => {
    const { state, entry } = setup()
    output(state, entry, 'x'.repeat(L.scrollbackBytes + L.chunkBytes))
    expect(entry.outputBytes).toBe(L.scrollbackBytes)
    expect(entry.chunks[0]?.seq).toBe(2)
    for (let n = 0; n < 2049; n++) output(state, entry, 'é')
    expect(entry.chunks).toHaveLength(2048)
    expect(entry.outputBytes).toBe(4096)
  })
  it('removes throwing listeners without starving later listeners', () => {
    const { state, entry } = setup()
    const bad = vi.fn(() => {
      throw new Error('disconnected')
    })
    const good = vi.fn()
    entry.listeners.add(bad)
    entry.listeners.add(good)
    output(state, entry, 'first')
    emit(entry, { type: 'terminal.ack', terminalId: entry.terminalId, seq: 1, accepted: true })
    expect(bad).toHaveBeenCalledOnce()
    expect(good).toHaveBeenCalledTimes(2)
    expect(entry.listeners.has(bad)).toBe(false)
  })
  it('does not retain late login output after exit or shutdown', () => {
    const { state, entry } = setup()
    entry.login = { owner: 'owner', finish() {} }
    entry.status = 'exited'
    output(state, entry, 'private')
    entry.status = 'running'
    state.closed = true
    output(state, entry, 'private')
    expect(entry.chunks).toEqual([])
    expect(entry.seq).toBe(0)
  })
})

describe('terminal service state', () => {
  it('restores running identities as interrupted with empty volatile buffers', () => {
    const { state, entry } = setup()
    const restored = createTerminalState({
      ...state.options,
      load: () => [{ terminalId: entry.terminalId, laneId: entry.laneId, status: 'running' }],
    })
    expect(restored.entries.get(entry.terminalId)).toMatchObject({
      status: 'interrupted',
      seq: 0,
      inputSeq: 0,
      chunks: [],
      outputBytes: 0,
    })
    expect(() => createTerminalState({ ...state.options, load: () => [{}] })).toThrow(
      'Invalid terminal state',
    )
  })
})
