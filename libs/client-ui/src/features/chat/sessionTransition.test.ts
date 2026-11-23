import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage, PiEvent } from '@shared/rpc'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { useChatStore } from '@/stores/chat'
import { useSessionsStore } from '@/stores/sessions'
import { useArtifactsStore } from '@/stores/artifacts'
// Loaded up front: a lane's tool_execution_end imports it to refresh files, and a first load
// racing the next test can resolve before the store exists.
import '@/stores/files'
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
const createSession = vi.fn()
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
  createSession
    .mockReset()
    .mockResolvedValue({ sessionId: 'audit', workspacePath: '/repo', pid: 1 })
  useSessionTransition.setState({ bySession: {} })
  fake = createFakePhosphor({
    'pi:command': command,
    'pi:createSession': createSession,
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

it('attaches to a lane already running in main without waiting for its turn to finish', async () => {
  createSession.mockResolvedValue({
    sessionId: 'audit',
    workspacePath: '/repo',
    diskPath: '/repo/clone.jsonl',
    pid: 1,
  })
  const normal = command.getMockImplementation()!
  command.mockImplementation(async (id, cmd) => {
    const result = await normal(id, cmd)
    if (cmd.type === 'get_state') result.data.isStreaming = true
    return result
  })
  await useSessionsStore.getState().createSession('/repo', { sessionPath: '/repo/clone.jsonl' })
  expect(sessionTransitionPending('audit')).toBe(false)
  expect(useChatStore.getState().sessions.audit?.meta?.isStreaming).toBe(true)
  expect(command).toHaveBeenCalledWith('audit', { type: 'get_messages' })
})

describe('opening a lane mid-turn', () => {
  const prompt = {
    role: 'user',
    content: 'Defrag. 1 waiting: 1 read. Start with brain_waiting.',
    timestamp: 1,
  } as const
  const plan = {
    id: 'harbor-plan',
    title: 'Harbor plan',
    type: 'markdown',
    content: '# Harbor',
    version: 1,
  }
  const answer: AgentMessage = {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Writing the Harbor plan.' },
      { type: 'toolCall', id: 'call-1', name: 'artifact_create', arguments: plan },
    ],
    stopReason: 'toolUse',
    timestamp: 2,
  }
  const result: AgentMessage = {
    role: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'artifact_create',
    content: [{ type: 'text', text: 'Created Harbor plan.' }],
    details: plan,
    isError: false,
    timestamp: 3,
  }
  /** What the lane sends while its history loads: the answer it was streaming, then its tool. */
  const during: PiEvent[] = [
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Writing the Harbor' },
    },
    { type: 'message_end', message: answer },
    { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'artifact_create', args: plan },
    {
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'artifact_create',
      result: { content: result.content, details: plan },
      isError: false,
    },
    { type: 'message_start', message: result },
    { type: 'message_end', message: result },
  ]
  const push = (event: PiEvent) => fake.events.onSessionPush.emit('audit', { kind: 'event', event })

  // Main forwards events as pi prints them but answers get_messages later, so pi may have read
  // its messages before the answer ended, before its result, or after both.
  it.each([
    ['before the answer ended', [prompt]],
    ['before the tool result', [prompt, answer]],
    ['after the tool result', [prompt, answer, result]],
  ] as const)(
    'loads its history read %s, then the events that arrived meanwhile, once each',
    async (_when, history) => {
      createSession.mockResolvedValue({
        sessionId: 'audit',
        workspacePath: '/repo',
        diskPath: '/repo/clone.jsonl',
        pid: 1,
      })
      let release!: () => void
      command.mockImplementation(async (_id, cmd) => {
        if (cmd.type === 'get_messages')
          return await new Promise((resolve) => {
            release = () => resolve({ success: true, data: { messages: history } })
          })
        if (cmd.type === 'get_state')
          return {
            success: true,
            data: { sessionFile: '/repo/clone.jsonl', sessionId: 'clone', isStreaming: true },
          }
        return { success: false }
      })
      const opening = useSessionsStore
        .getState()
        .createSession('/repo', { sessionPath: '/repo/clone.jsonl' })
      await vi.waitFor(() => expect(release).toBeTypeOf('function'))
      for (const event of during) push(event)
      await vi.waitFor(() =>
        expect(useArtifactsStore.getState().bySession.audit?.['harbor-plan']).toBeDefined(),
      )
      release()
      await opening

      const chat = () => useChatStore.getState().sessions.audit!
      expect(chat().error).toBeNull()
      expect(sessionTransitionPending('audit')).toBe(false)
      expect(chat().items).toMatchObject([
        { kind: 'user', text: prompt.content },
        {
          kind: 'assistant',
          streaming: false,
          blocks: [
            { type: 'text', text: 'Writing the Harbor plan.' },
            { type: 'tool', toolCallId: 'call-1' },
          ],
        },
      ])
      expect(chat().tools['call-1']).toMatchObject({ status: 'done', toolName: 'artifact_create' })
      expect(useArtifactsStore.getState().bySession.audit?.['harbor-plan']?.versions).toHaveLength(
        1,
      )
      // Then it follows the live turn.
      push({ type: 'message_start', message: { role: 'assistant', content: [] } })
      push({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Approved.' },
      })
      expect(chat().items).toHaveLength(3)
      expect(chat().items[2]).toMatchObject({
        kind: 'assistant',
        streaming: true,
        blocks: [{ type: 'text', text: 'Approved.' }],
      })
    },
  )

  /** Opens the lane while pi reports its turn running; `history` answers get_messages. */
  function openRunning(history: () => Promise<unknown>) {
    createSession.mockResolvedValue({
      sessionId: 'audit',
      workspacePath: '/repo',
      diskPath: '/repo/clone.jsonl',
      pid: 1,
    })
    command.mockImplementation(async (_id, cmd) => {
      if (cmd.type === 'get_messages') return history()
      if (cmd.type === 'get_state')
        return {
          success: true,
          data: { sessionFile: '/repo/clone.jsonl', sessionId: 'clone', isStreaming: true },
        }
      return { success: false }
    })
    return useSessionsStore.getState().createSession('/repo', { sessionPath: '/repo/clone.jsonl' })
  }
  const chat = () => useChatStore.getState().sessions.audit!
  const loaded = { success: true, data: { messages: [prompt] } }

  it('shows its turn running, so the lane offers Stop until the turn ends', async () => {
    await openRunning(async () => loaded)
    expect(chat()).toMatchObject({ error: null, isStreaming: true })
    expect(chat().agentStartedAt).toBeTypeOf('number')
    push({ type: 'agent_end', messages: [] })
    expect(chat().isStreaming).toBe(false)
  })

  it('comes up idle when its turn ended while the history loaded', async () => {
    let release!: () => void
    const opening = openRunning(() => new Promise((resolve) => (release = () => resolve(loaded))))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    push({ type: 'agent_end', messages: [] })
    release()
    await opening
    expect(chat()).toMatchObject({ error: null, isStreaming: false })
  })

  it('stops recording when its history fails to load, and records again on Retry', async () => {
    const subscribe = fake.api.onSessionPush
    const listening = new Set<object>()
    vi.spyOn(fake.api, 'onSessionPush').mockImplementation((id, listener) => {
      const token = {}
      listening.add(token)
      const stop = subscribe(id, listener)
      return () => {
        listening.delete(token)
        stop()
      }
    })
    let answers = 0
    let release!: () => void
    await openRunning(() =>
      ++answers === 1
        ? Promise.resolve({ success: false, error: 'pi did not answer.' })
        : new Promise((resolve) => (release = () => resolve(loaded))),
    )
    const retry = useSessionTransition.getState().bySession.audit?.retry
    expect(retry).toBeTypeOf('function')
    // Only the lane's own push handler is left: nothing keeps piling up its events.
    const handlers = listening.size
    const retrying = retry!()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(listening.size).toBe(handlers + 1)
    push({ type: 'message_start', message: { role: 'assistant', content: [] } })
    push({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Approved.' },
    })
    release()
    await retrying
    expect(chat().error).toBeNull()
    expect(listening.size).toBe(handlers)
    expect(chat().items.at(-1)).toMatchObject({
      kind: 'assistant',
      streaming: true,
      blocks: [{ type: 'text', text: 'Approved.' }],
    })
  })
})

it('keeps the activity guard when the lane main runs was idle as it opened', async () => {
  createSession.mockResolvedValue({
    sessionId: 'audit',
    workspacePath: '/repo',
    diskPath: '/repo/clone.jsonl',
    pid: 1,
  })
  const normal = command.getMockImplementation()!
  let release!: () => void
  command.mockImplementation(async (id, cmd) => {
    if (cmd.type !== 'get_messages') return normal(id, cmd)
    return await new Promise((resolve) => {
      release = () => resolve({ success: true, data: { messages: [] } })
    })
  })
  const opening = useSessionsStore
    .getState()
    .createSession('/repo', { sessionPath: '/repo/clone.jsonl' })
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  fake.events.onSessionPush.emit('audit', { kind: 'event', event: { type: 'agent_start' } })
  release()
  await opening
  expect(useChatStore.getState().sessions.audit?.error).toBe(
    'Session activity changed while loading. Retry when the turn finishes.',
  )
  expect(useSessionTransition.getState().bySession.audit?.retry).toBeTypeOf('function')
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
