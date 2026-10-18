import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { TerminalFrame, TerminalSubscribe } from '@phosphor/shared/host-protocol-terminals'
import { createEntry, createTerminalState } from './service-state'
import { output } from './output'
import { subscribe } from './subscriptions'

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
  state.entries.set(entry.terminalId, entry)
  const reap = vi.fn()
  const watch = (after?: TerminalSubscribe['after'], owner?: string) => {
    const frames: TerminalFrame[] = []
    const drop = subscribe(
      state,
      reap,
      { type: 'subscribe', topic: 'terminal', id: 'sub', terminalId: entry.terminalId, after },
      (frame) => frames.push(frame),
      owner,
    )
    return { frames, drop }
  }
  return { state, entry, reap, watch }
}
describe('terminal subscriptions', () => {
  it('replays after the oldest boundary, rewrites live ids and removes unsubscribed listeners', () => {
    const { state, entry, reap, watch } = setup()
    output(state, entry, 'one')
    output(state, entry, 'two')
    const { frames, drop } = watch({ epoch: state.options.epoch, seq: 1 })
    expect(frames).toMatchObject([{ type: 'terminal.output', id: 'sub', seq: 2, data: 'two' }])
    output(state, entry, 'three')
    expect(frames[1]).toMatchObject({ id: 'sub', seq: 3, data: 'three' })
    drop?.()
    output(state, entry, 'four')
    expect(frames).toHaveLength(2)
    expect(entry.listeners.size).toBe(0)
    expect(reap).toHaveBeenCalledOnce()
  })
  it('resets wrong/future/stale cursors and exited state with input sequence', () => {
    const { state, entry, watch } = setup()
    entry.seq = 5
    entry.inputSeq = 3
    output(state, entry, 'retained')
    for (const after of [
      undefined,
      { epoch: 'b'.repeat(16), seq: 5 },
      { epoch: state.options.epoch, seq: 7 },
      { epoch: state.options.epoch, seq: 4 },
    ]) {
      const { frames, drop } = watch(after)
      expect(frames).toMatchObject([
        { type: 'terminal.reset', seq: 6, data: 'retained', inputSeq: 3, status: 'running' },
      ])
      drop?.()
    }
    entry.status = 'exited'
    expect(watch({ epoch: state.options.epoch, seq: 6 }).frames[0]?.type).toBe('terminal.reset')
  })
  it('checks login ownership before clearing disconnect time and consumes content-free tombstones once', () => {
    const { state, entry, watch } = setup()
    entry.login = { owner: 'owner', disconnectedAt: 42, finish() {} }
    expect(watch(undefined, 'other')).toEqual({ frames: [], drop: null })
    expect(entry.login.disconnectedAt).toBe(42)
    watch(undefined, 'owner').drop?.()
    expect(entry.login.disconnectedAt).toBeUndefined()
    entry.status = 'exited'
    entry.exitCode = 9
    const { frames, drop } = watch(undefined, 'owner')
    expect(frames).toMatchObject([
      { type: 'terminal.reset', data: '', status: 'exited' },
      { type: 'terminal.exit', exitCode: 9 },
    ])
    expect(state.entries.size).toBe(0)
    expect(entry.listeners.size).toBe(0)
    drop?.()
    expect(watch(undefined, 'owner').drop).toBeNull()
  })
  it('refuses subscriptions after shutdown without reaping', () => {
    const { state, reap, watch } = setup()
    state.closed = true
    expect(watch().drop).toBeNull()
    expect(reap).not.toHaveBeenCalled()
  })
})
