import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcCommand, RpcSessionState } from '@shared/rpc'
import type { SessionMeta } from '@shared/models'
import { useChatStore } from '@/stores/chat'
import { useSessionsStore } from '@/stores/sessions'
import { cloneSession } from './sidebarActions'

const invoke = vi.fn()
const piCommand = vi.fn()

const meta: SessionMeta = {
  path: '/repo/.pi/sessions/old.jsonl',
  sessionId: 'a',
  cwd: '/repo',
  createdAt: '2026-08-09T00:00:00.000Z',
  userMessages: 1,
  assistantMessages: 1,
  toolCalls: 0,
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
  headroomSavedTokens: 0,
  entryCount: 1,
  branchCount: 0,
  mtimeMs: 0,
  lastActivityAt: '2026-08-09T00:00:00.000Z',
}

function sessionState(sessionFile: string): RpcSessionState {
  return {
    thinkingLevel: 'medium',
    isStreaming: false,
    isCompacting: false,
    steeringMode: 'all',
    followUpMode: 'all',
    sessionFile,
    sessionId: 'pi-session',
    autoCompactionEnabled: true,
    messageCount: 1,
    pendingMessageCount: 0,
  }
}

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(undefined)
  piCommand.mockReset()
  vi.stubGlobal('window', { phosphor: { invoke, piCommand } })
  useChatStore.setState({ sessions: {} }, false)
  useSessionsStore.setState({
    live: { s1: { phosphorId: 's1', workspacePath: '/repo', diskPath: meta.path } },
    activeSessionId: 's1',
  })
})

/**
 * pi's `clone` RPC is `fork` under the hood (position "at" the current leaf),
 * so like a rewind it always swaps the live session onto a brand-new file —
 * verified against the installed pi core. Cloning a live session must relearn
 * that file the same way rewind does, or the sidebar keeps tracking the
 * pre-clone file as the live one.
 */
describe('cloneSession', () => {
  it('relearns the new session file for a live session', async () => {
    piCommand.mockImplementation((_sessionId: string, command: RpcCommand) => {
      if (command.type === 'clone') {
        return Promise.resolve({ success: true, data: { cancelled: false } })
      }
      if (command.type === 'get_state') {
        return Promise.resolve({
          success: true,
          data: sessionState('/repo/.pi/sessions/cloned.jsonl'),
        })
      }
      return Promise.resolve({ success: false })
    })

    await cloneSession('/repo', meta, 's1')

    expect(useSessionsStore.getState().live.s1?.diskPath).toBe('/repo/.pi/sessions/cloned.jsonl')
    // The clone's new pi session id orphans a pi-claude-cli CLI session, so
    // the main process must be told to fork the CLI ledger — with the
    // CLONE's file, not the pre-clone one.
    expect(invoke).toHaveBeenCalledWith(
      'sessions:forkClaudeLedger',
      '/repo/.pi/sessions/cloned.jsonl',
    )
  })

  it('leaves diskPath alone when an extension cancels the clone', async () => {
    piCommand.mockImplementation((_sessionId: string, command: RpcCommand) => {
      if (command.type === 'clone') {
        return Promise.resolve({ success: true, data: { cancelled: true } })
      }
      return Promise.resolve({ success: false })
    })

    await cloneSession('/repo', meta, 's1')

    expect(useSessionsStore.getState().live.s1?.diskPath).toBe(meta.path)
    expect(useChatStore.getState().sessions.s1?.error).toBe('Clone was cancelled by an extension.')
    expect(invoke).not.toHaveBeenCalledWith('sessions:forkClaudeLedger', expect.anything())
  })
})
