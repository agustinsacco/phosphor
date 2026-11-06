import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { useChatStore } from '@/stores/chat'
import { useSessionsStore } from '@/stores/sessions'
import { useArtifactsStore } from '@/stores/artifacts'
import { canControlSession } from '@/stores/remoteLanes'
import { currentBranchUserMessages, rewindToEntry } from './rewind'
import {
  changeSessionBranch,
  sessionTransitionPending,
  useSessionTransition,
} from '@/features/sessions/sessionTransition'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useChatUiStore } from './uiState'
import { SWARM_COMMAND, SWARM_STATUS_KEY } from '@phosphor/pi-extensions/swarm'

const command = vi.fn()
const artifactRead = vi.fn(async () => [])
let restore: () => void
let fake: ReturnType<typeof createFakePhosphor>

beforeEach(() => {
  command.mockReset().mockImplementation(async (_id, cmd) => {
    if (cmd.type === 'fork') return { success: true, data: { cancelled: false, text: 'again' } }
    if (cmd.type === 'get_messages') return { success: true, data: { messages: [] } }
    if (cmd.type === 'get_state')
      return {
        success: true,
        data: {
          sessionFile: '/repo/clone.jsonl',
          sessionId: 'clone',
          isStreaming: false,
        },
      }
    return { success: false }
  })
  artifactRead.mockClear()
  useSessionTransition.setState({ bySession: {} })
  fake = createFakePhosphor({
    'pi:command': command,
    'pi:createSession': async () => ({ sessionId: 'audit', workspacePath: '/repo', pid: 1 }),
    'git:sessionBaseline': async () => null,
    'sessions:list': async () => [],
    'artifacts:forSession': artifactRead,
    'app:setRewoundSessions': async () => undefined,
    'app:setLastSession': async () => undefined,
    'app:markSessionSeen': async () => undefined,
    'claude:bindSession': async () => undefined,
  })
  vi.stubGlobal('window', {})
  restore = installFakePhosphor(fake)
  useSessionsStore.setState({ live: {}, activeSessionId: null, rewound: {}, unread: {} })
  useChatStore.setState({ sessions: {} })
  useArtifactsStore.setState({ bySession: {}, selected: {}, selectedVersion: {}, unseen: {} })
})
afterEach(() => {
  restore()
  fake.dispose()
  vi.unstubAllGlobals()
})

function live() {
  useSessionsStore.setState({
    live: {
      audit: {
        phosphorId: 'audit',
        workspacePath: '/repo',
        diskPath: '/repo/parent.jsonl',
      },
    },
  })
  useChatStore.getState().ensure('audit')
}

it('loads the inherited history and artifacts for a closed-session fork/clone', async () => {
  await useSessionsStore.getState().createSession('/repo', { forkFrom: '/repo/parent.jsonl' })
  await vi.waitFor(() =>
    expect(command.mock.calls.some(([, c]) => c.type === 'get_state')).toBe(true),
  )
  expect(command.mock.calls.some(([, c]) => c.type === 'get_messages')).toBe(true)
  expect(artifactRead).toHaveBeenCalledWith('/repo/clone.jsonl')
  expect(useChatStore.getState().sessions.audit).toMatchObject({ items: [], resuming: false })
})

it('rewind removes artifacts that only existed after its new branch point', async () => {
  live()
  useArtifactsStore.getState().ingest('audit', 'artifact_create', {
    id: 'future-doc',
    title: 'Future',
    type: 'markdown',
    content: 'discarded future',
    version: 1,
  })
  await rewindToEntry('audit', 'before-artifact')
  expect(useSessionsStore.getState().live.audit?.diskPath).toBe('/repo/clone.jsonl')
  expect(useChatStore.getState().sessions.audit?.items).toEqual([])
  expect(useArtifactsStore.getState().bySession.audit?.['future-doc']).toBeUndefined()
  expect(artifactRead).toHaveBeenCalledWith('/repo/clone.jsonl')
})

it('does not erase new activity that arrives during rewind hydration', async () => {
  live()
  let release!: () => void
  command.mockImplementation(async (_id, cmd) => {
    if (cmd.type === 'fork') return { success: true, data: { cancelled: false, text: 'again' } }
    if (cmd.type === 'get_messages')
      return await new Promise((resolve) => {
        release = () => resolve({ success: true, data: { messages: [] } })
      })
    if (cmd.type === 'get_state')
      return {
        success: true,
        data: {
          sessionFile: '/repo/clone.jsonl',
          sessionId: 'clone',
          isStreaming: false,
        },
      }
    return { success: false }
  })
  const pending = rewindToEntry('audit', 'entry')
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  expect(canControlSession('audit')).toBe(true)
  useChatStore.getState().addUserMessage('audit', 'next prompt')
  useChatStore.getState().applyEvent('audit', { type: 'agent_start' })
  expect(useChatStore.getState().sessions.audit?.isStreaming).toBe(true)
  release()
  await pending
  expect(useChatStore.getState().sessions.audit?.isStreaming).toBe(true)
  expect(useChatStore.getState().sessions.audit?.items).toMatchObject([{ text: 'next prompt' }])
})

it('entry loading returns the recoverable failure sentinel for transport rejection', async () => {
  command.mockRejectedValue(new Error('transport disconnected'))
  await expect(currentBranchUserMessages('audit')).resolves.toBeNull()
})

it('reports a failed identity refresh after a successful rewind', async () => {
  live()
  command.mockImplementation(async (_id, cmd) => {
    if (cmd.type === 'fork') return { success: true, data: { cancelled: false, text: 'again' } }
    if (cmd.type === 'get_messages') return { success: true, data: { messages: [] } }
    return { success: false, error: 'state temporarily unavailable' }
  })
  await rewindToEntry('audit', 'entry')
  expect(useSessionsStore.getState().live.audit?.diskPath).toBe('/repo/parent.jsonl')
  expect(useSessionsStore.getState().rewound).toEqual({})
  expect(useChatStore.getState().sessions.audit?.error).toBeTruthy()
})

beforeEach(() => {
  useExtensionUiStore.setState({ statuses: {} })
  useChatUiStore.setState({ prefill: {} })
})

it('retries reconciliation without forking again and keeps sending locked until ready', async () => {
  live()
  const normal = command.getMockImplementation()!
  let fail = true
  command.mockImplementation(async (id, cmd) => {
    if (cmd.type === 'get_state' && fail) return { success: false }
    return normal(id, cmd)
  })
  const run = rewindToEntry('audit', 'entry')
  expect(sessionTransitionPending('audit')).toBe(true)
  await run
  expect(sessionTransitionPending('audit')).toBe(true)
  const retry = useSessionTransition.getState().bySession.audit?.retry
  expect(retry).toBeTypeOf('function')
  fail = false
  await retry!()
  expect(command.mock.calls.filter(([, c]) => c.type === 'fork')).toHaveLength(1)
  expect(useSessionsStore.getState().rewound).toEqual({ 'parent.jsonl': 'clone.jsonl' })
  expect(useChatUiStore.getState().prefill.audit?.text).toBe('again')
  expect(sessionTransitionPending('audit')).toBe(false)
})

it.each([true, false])(
  'rewind preserves the current Swarm request (%s), not the historical branch value',
  async (requested) => {
    live()
    useExtensionUiStore.setState({
      statuses: {
        audit: {
          [SWARM_STATUS_KEY]: JSON.stringify({
            version: 1,
            available: true,
            requested,
            enabled: requested,
          }),
        },
      },
    })
    const normal = command.getMockImplementation()!
    command.mockImplementation(async (id, cmd) => {
      if (cmd.type === 'get_commands')
        return {
          success: true,
          data: {
            commands: [{ name: SWARM_COMMAND, source: 'extension' }],
          },
        }
      if (cmd.type === 'prompt') return { success: true }
      return normal(id, cmd)
    })
    await rewindToEntry('audit', 'before-toggle')
    expect(command).toHaveBeenCalledWith('audit', {
      type: 'prompt',
      message: `/${SWARM_COMMAND} ${requested ? 'on' : 'off'}`,
    })
    expect(sessionTransitionPending('audit')).toBe(false)
  },
)

it('does not mutate a running session', async () => {
  live()
  useChatStore.getState().applyEvent('audit', { type: 'agent_start' })
  await changeSessionBranch('audit', { type: 'clone' })
  expect(command).not.toHaveBeenCalled()
  expect(useChatStore.getState().sessions.audit?.error).toContain('Wait for this turn')
  expect(sessionTransitionPending('audit')).toBe(false)
})

it('keeps an artifact-load failure recoverable instead of silently showing an empty clone', async () => {
  live()
  artifactRead.mockRejectedValueOnce(new Error('artifact read failed'))
  await rewindToEntry('audit', 'entry')
  expect(sessionTransitionPending('audit')).toBe(true)
  await useSessionTransition.getState().bySession.audit?.retry?.()
  expect(sessionTransitionPending('audit')).toBe(false)
  expect(command.mock.calls.filter(([, c]) => c.type === 'fork')).toHaveLength(1)
})
