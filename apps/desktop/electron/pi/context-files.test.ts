import { describe, expect, it, vi } from 'vitest'
import type { ContextFileKind } from '@shared/context-files'
import { setLaneContextFile, type ContextFileDeps } from './context-files'

function deps(overrides: Partial<ContextFileDeps> = {}) {
  const request = vi.fn(async () => ({ type: 'response', command: 'prompt', success: true }))
  const save = vi.fn((kind: ContextFileKind, included: boolean) => ({
    claude: true,
    agents: true,
    [kind]: included === true,
  }))
  const all: ContextFileDeps = {
    save,
    isStub: () => false,
    ownedByRoutine: () => false,
    session: () => ({ client: { request } }) as never,
    ...overrides,
  }
  return { all, save, request }
}

describe('setLaneContextFile', () => {
  it('saves the preference and sends the host command to the lane', async () => {
    const d = deps()
    await setLaneContextFile(d.all, 'claude', false, 'live-1')
    expect(d.save).toHaveBeenCalledWith('claude', false)
    expect(d.request).toHaveBeenCalledWith({
      type: 'prompt',
      message: '/phosphor-context-files claude=off',
    })
  })

  it('only saves the preference from the home composer, the stub, or a lane still starting', async () => {
    for (const [overrides, sessionId] of [
      [{}, undefined],
      [{ isStub: () => true }, 'live-1'],
      [{ session: () => undefined }, 'live-1'],
    ] as const) {
      const d = deps(overrides)
      await setLaneContextFile(d.all, 'agents', true, sessionId)
      expect(d.save).toHaveBeenCalledOnce()
      expect(d.request).not.toHaveBeenCalled()
    }
  })

  it('refuses a routine-owned lane before saving anything', async () => {
    const d = deps({ ownedByRoutine: () => true })
    await expect(setLaneContextFile(d.all, 'claude', false, 'routine-1')).rejects.toThrow(
      /owned by a running routine/,
    )
    expect(d.save).not.toHaveBeenCalled()
    expect(d.request).not.toHaveBeenCalled()
  })

  it('reports a lane that refused the command', async () => {
    const d = deps()
    d.request.mockResolvedValueOnce({
      type: 'response',
      command: 'prompt',
      success: false,
      error: 'pi exited',
    } as never)
    await expect(setLaneContextFile(d.all, 'claude', true, 'live-1')).rejects.toThrow('pi exited')
  })
})
