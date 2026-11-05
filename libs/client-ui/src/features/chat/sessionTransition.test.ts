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
  fake = createFakePhosphor({
    'pi:command': command,
    'pi:createSession': async () => ({ sessionId: 'audit', workspacePath: '/repo', pid: 1 }),
    'git:sessionBaseline': async () => null,
    'sessions:listMany': async () => [],
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
