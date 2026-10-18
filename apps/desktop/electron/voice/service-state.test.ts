import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_VOICE_PREFS } from '@shared/voice'
import { deferred, VoiceServiceState } from './service-state'

describe('VoiceServiceState', () => {
  it('keeps each instance and published status snapshots independent', () => {
    const publish = vi.fn()
    const first = new VoiceServiceState(DEFAULT_VOICE_PREFS, publish)
    const second = new VoiceServiceState(DEFAULT_VOICE_PREFS, vi.fn())
    const original = first.status
    first.owner = 4
    first.pending.set(1, deferred<string>())
    const next = first.set({ phase: 'ready', receivedBytes: 10 })
    expect(next).not.toBe(original)
    expect(original.phase).toBe('off')
    expect(publish).toHaveBeenCalledExactlyOnceWith(next)
    expect(second.status.phase).toBe('off')
    expect(second.owner).toBeNull()
    expect(second.pending.size).toBe(0)
  })

  it('keeps the error only while the resulting status is error', () => {
    const state = new VoiceServiceState(DEFAULT_VOICE_PREFS, vi.fn())
    state.set({ phase: 'error', error: 'failed' })
    expect(state.set({ receivedBytes: 1 }).error).toBe('failed')
    expect(state.set({ phase: 'downloading' })).not.toHaveProperty('error')
  })

  it('handles early deferred rejection even when the consumer awaits later', async () => {
    const reply = deferred<string>()
    reply.reject(new Error('early'))
    await new Promise<void>((resolve) => setImmediate(resolve))
    await expect(reply.promise).rejects.toThrow('early')
    const success = deferred<string>()
    success.resolve('text')
    await expect(success.promise).resolves.toBe('text')
  })

  it('rejects and clears every pending reply without affecting other state', async () => {
    const state = new VoiceServiceState(DEFAULT_VOICE_PREFS, vi.fn())
    const first = deferred<string>()
    const second = deferred<string>()
    state.pending.set(1, first)
    state.pending.set(2, second)
    state.owner = 9
    state.failPending('stopped')
    await expect(first.promise).rejects.toThrow('stopped')
    await expect(second.promise).rejects.toThrow('stopped')
    expect(state.pending.size).toBe(0)
    expect(state.owner).toBe(9)
  })
})
