import { describe, it, expect, vi, beforeEach } from 'vitest'
import { piCall, piCallOk, rehydrateTranscript } from './rpc'
import { useChatStore } from '@/stores/chat'

const piCommand = vi.fn()

beforeEach(() => {
  piCommand.mockReset()
  vi.stubGlobal('window', { phosphor: { piCommand } })
  useChatStore.setState({ sessions: {} }, false)
})

/** Read back whatever error the store recorded for a session. */
function storedError(sessionId: string): string | null | undefined {
  return useChatStore.getState().sessions[sessionId]?.error
}

describe('piCall', () => {
  it('returns the response data on success', async () => {
    piCommand.mockResolvedValue({ success: true, data: { path: '/tmp/out.html' } })
    await expect(
      piCall('s1', { type: 'export_html', outputPath: '/tmp/out.html' }),
    ).resolves.toEqual({ path: '/tmp/out.html' })
  })

  it('forwards the session id and command verbatim', async () => {
    piCommand.mockResolvedValue({ success: true, data: undefined })
    await piCall('s1', { type: 'abort' })
    expect(piCommand).toHaveBeenCalledWith('s1', { type: 'abort' })
  })

  it('returns undefined and records the error on failure', async () => {
    piCommand.mockResolvedValue({ success: false, error: 'pi exploded' })
    await expect(piCall('s1', { type: 'abort' })).resolves.toBeUndefined()
    expect(storedError('s1')).toBe('pi exploded')
  })

  it('falls back to a command-named message when the error is absent', async () => {
    piCommand.mockResolvedValue({ success: false })
    await piCall('s1', { type: 'compact' })
    expect(storedError('s1')).toBe('compact failed')
  })

  it('does not record an error on success', async () => {
    piCommand.mockResolvedValue({ success: true, data: undefined })
    await piCall('s1', { type: 'abort' })
    expect(storedError('s1')).toBeFalsy()
  })
})

describe('piCallOk', () => {
  it('resolves true on success', async () => {
    piCommand.mockResolvedValue({ success: true, data: undefined })
    await expect(piCallOk('s1', { type: 'set_auto_retry', enabled: true })).resolves.toBe(true)
  })

  it('resolves false and records the error on failure', async () => {
    piCommand.mockResolvedValue({ success: false, error: 'nope' })
    await expect(piCallOk('s1', { type: 'set_auto_retry', enabled: true })).resolves.toBe(false)
    expect(storedError('s1')).toBe('nope')
  })

  it('reports failures that call sites used to swallow silently', async () => {
    // Regression: roughly half the piCommand call sites had no else branch, so
    // a failed toggle left the UI showing the old value with no feedback.
    piCommand.mockResolvedValue({ success: false, error: 'set_model rejected' })
    const ok = await piCallOk('s1', { type: 'set_model', provider: 'anthropic', modelId: 'x' })
    expect(ok).toBe(false)
    expect(storedError('s1')).toBe('set_model rejected')
  })
})

describe('rehydrateTranscript', () => {
  it('replaces the rendered items and hands the messages back', async () => {
    const messages = [{ role: 'user', content: 'hi' }]
    piCommand.mockResolvedValue({ success: true, data: { messages } })

    await expect(rehydrateTranscript('s1')).resolves.toBe(messages)
    expect(piCommand).toHaveBeenCalledWith('s1', { type: 'get_messages' })
    expect(useChatStore.getState().sessions.s1?.items).toHaveLength(1)
  })

  it('reports the failure instead of leaving the old transcript in place silently', async () => {
    // All three former call sites (rewind, fork picker, resume) checked
    // `success && data` and did nothing at all when it was false.
    piCommand.mockResolvedValue({ success: false, error: 'session gone' })

    await expect(rehydrateTranscript('s1')).resolves.toBeUndefined()
    expect(storedError('s1')).toBe('session gone')
  })
})
