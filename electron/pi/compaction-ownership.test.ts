import { describe, expect, it, vi } from 'vitest'
import { applyCompactionOwnership, piAutoCompactionFor } from './compaction-ownership'
import type { PiRpcClient } from './rpc-client'
import type { RpcCommand } from '@shared/rpc'

function client(state: { provider?: string; autoCompactionEnabled: boolean } | null) {
  const request = vi.fn(async (command: RpcCommand) => {
    if (command.type === 'get_state') {
      if (!state) return { type: 'response', command: 'get_state', success: false }
      return {
        type: 'response',
        command: 'get_state',
        success: true,
        data: {
          model: state.provider ? { provider: state.provider } : null,
          autoCompactionEnabled: state.autoCompactionEnabled,
        },
      }
    }
    return { type: 'response', command: command.type, success: true }
  })
  return { request, mock: { request } as unknown as Pick<PiRpcClient, 'request'> }
}

describe('piAutoCompactionFor', () => {
  it('leaves pi in charge for every provider but Claude Code', () => {
    expect(piAutoCompactionFor('openai-codex')).toBe(true)
    expect(piAutoCompactionFor('anthropic')).toBe(true)
    expect(piAutoCompactionFor(undefined)).toBe(true)
    expect(piAutoCompactionFor('pi-claude-cli')).toBe(false)
  })
})

describe('applyCompactionOwnership', () => {
  it('switches pi auto-compaction off for a Claude Code session', async () => {
    const { request, mock } = client({ provider: 'pi-claude-cli', autoCompactionEnabled: true })
    await expect(applyCompactionOwnership(mock)).resolves.toBe('cli')
    expect(request).toHaveBeenCalledWith({ type: 'set_auto_compaction', enabled: false })
  })

  it('switches it back on when a session moves to another provider', async () => {
    const { request, mock } = client({ provider: 'openai-codex', autoCompactionEnabled: false })
    await expect(applyCompactionOwnership(mock)).resolves.toBe('pi')
    expect(request).toHaveBeenCalledWith({ type: 'set_auto_compaction', enabled: true })
  })

  it('sends nothing when the session is already in the right state', async () => {
    const { request, mock } = client({ provider: 'pi-claude-cli', autoCompactionEnabled: false })
    await applyCompactionOwnership(mock)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]?.[0]).toEqual({ type: 'get_state' })
  })

  it('does nothing it cannot justify when get_state fails', async () => {
    const { request, mock } = client(null)
    await expect(applyCompactionOwnership(mock)).resolves.toBe('unknown')
    expect(request).toHaveBeenCalledTimes(1)
  })
})
