// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UNKNOWN_OUTCOME } from '@shared/errors'
import type { RpcCommand, RpcResponse, RpcResponseDataMap } from '@shared/rpc'
import { installMockPhosphor } from '@/dev/mockPhosphor'
import { hostLaneSession, mockRemoteInfo } from '@/dev/mockRemoteLanes'
import { useChatStore } from '@/stores/chat'
import { useDraftsStore } from '@/stores/drafts'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { usePendingQueue } from './composer/pendingQueue'
import { sendComposerPrompt } from './sendComposerPrompt'

/** pi's own words when a plain prompt reaches it mid-run. */
const PI_BUSY =
  "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."
const KEY = 'draft-key'
const id = mockRemoteInfo.sessionId

type Prompt = Extract<RpcCommand, { type: 'prompt' }>
type PromptResponse = RpcResponse<RpcResponseDataMap['prompt']>
const accepted = (disposition: 'started' | 'queued'): PromptResponse => ({
  type: 'response',
  command: 'prompt',
  success: true,
  data: { disposition },
})
const refused = (error: string): PromptResponse => ({
  type: 'response',
  command: 'prompt',
  success: false,
  error,
})

function answers(...responses: PromptResponse[]) {
  const pi = vi.spyOn(window.phosphor, 'piCommand')
  for (const response of responses) pi.mockResolvedValueOnce(response)
  return () => pi.mock.calls.map(([, command]) => command as Prompt)
}

const send = (remote: boolean, busyBehavior?: 'steer' | 'followUp') =>
  sendComposerPrompt({
    sessionId: id,
    draftKey: KEY,
    remote,
    remoteAttachments: false,
    busyBehavior,
  })
const session = () => useChatStore.getState().sessions[id]!

function hostLane(activity: 'idle' | 'working') {
  const { hosts, live } = hostLaneSession({ activity, self: true })
  useRemoteLanesStore.setState({ hosts })
  useSessionsStore.setState({ live })
}

beforeEach(() => {
  installMockPhosphor()
  useChatStore.setState({ sessions: {} })
  useChatStore.getState().ensure(id)
  useSessionsStore.setState({ live: {} })
  useRemoteLanesStore.setState({ hosts: {} })
  useDraftsStore.setState({ drafts: { [KEY]: { text: 'PHX-message', attachments: [] } } })
})
afterEach(() => {
  vi.restoreAllMocks()
  useDraftsStore.getState().clear(KEY)
  useSessionsStore.setState({ live: {} })
  useRemoteLanesStore.setState({ hosts: {} })
})

describe('the busy behaviour', () => {
  it('an idle lane sends Enter once with a follow-up fallback and its pending bubble', async () => {
    const prompts = answers(accepted('started'))
    await send(false, 'steer')
    expect(prompts()).toEqual([
      { type: 'prompt', message: 'PHX-message', streamingBehavior: 'followUp' },
    ])
    expect(session().items).toMatchObject([{ kind: 'user', text: 'PHX-message', optimistic: true }])
  })

  it('Send steers while the Host reports the lane working and the chat thinks it idle', async () => {
    hostLane('working')
    const prompts = answers(accepted('queued'))
    await send(true)
    expect(prompts()).toEqual([
      { type: 'prompt', message: 'PHX-message', streamingBehavior: 'steer', busy: true },
    ])
    expect(session().items).toEqual([])
    expect(session().error).toBeNull()
  })

  it('a modified Enter queues a follow-up while the Host reports the lane working', async () => {
    hostLane('working')
    const prompts = answers(accepted('queued'))
    await send(true, 'followUp')
    expect(prompts()).toEqual([
      { type: 'prompt', message: 'PHX-message', streamingBehavior: 'followUp', busy: true },
    ])
  })

  it.each(['steer', 'followUp'] as const)(
    'clears and sends repeated %s drafts without waiting on pi, restoring a refusal',
    async (behavior) => {
      hostLane('working')
      let finish!: (reply: PromptResponse) => void
      const pi = vi.spyOn(window.phosphor, 'piCommand')
      pi.mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve
        }),
      )
      pi.mockResolvedValueOnce(accepted('queued'))
      const first = send(true, behavior)
      const cleared = useDraftsStore.getState().get(KEY).text
      useDraftsStore.getState().setText(KEY, 'second')
      const second = send(true, behavior)
      const sent = pi.mock.calls.map(([, command]) => command)
      try {
        expect(cleared).toBe('')
        expect(usePendingQueue.getState().chips.map((chip) => chip.text)).toEqual([
          'PHX-message',
          'second',
        ])
        expect(sent).toMatchObject([
          { message: 'PHX-message', busy: true, streamingBehavior: behavior },
          { message: 'second', busy: true, streamingBehavior: behavior },
        ])
        expect(useDraftsStore.getState().get(KEY).text).toBe('')
      } finally {
        finish(refused('rejected'))
        await Promise.all([first, second])
      }
      expect(useDraftsStore.getState().get(KEY).text).toBe('PHX-message')
      expect(usePendingQueue.getState().chips).toEqual([])
    },
  )

  it('a message typed while the last prompt waits for pi steers instead of vanishing', async () => {
    useChatStore.getState().addUserMessage(id, 'first')
    const prompts = answers(accepted('queued'))
    await send(false)
    expect(prompts()).toEqual([
      { type: 'prompt', message: 'PHX-message', streamingBehavior: 'steer', busy: true },
    ])
  })
})

describe.each([
  ['This Mac', false],
  ['a Host lane', true],
])('when composer activity lags on %s', (_, remote) => {
  beforeEach(() => {
    if (remote) hostLane('idle')
  })

  it('queues on the first try if pi became busy, without replaying its input hooks', async () => {
    const pi = vi
      .spyOn(window.phosphor, 'piCommand')
      .mockImplementation(async (_id, command) =>
        command.type === 'prompt' && command.streamingBehavior
          ? accepted('queued')
          : refused(PI_BUSY),
      )
    await send(remote)
    expect(pi.mock.calls.map(([, command]) => command)).toEqual([
      { type: 'prompt', message: 'PHX-message', streamingBehavior: 'followUp' },
    ])
    expect(session()).toMatchObject({ error: null, items: [], promptSentAt: null })
    expect(useDraftsStore.getState().get(KEY).text).toBe('')
  })

  it('keeps the draft if pi started compacting before it received the prompt', async () => {
    const prompts = answers(
      refused(
        'Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.',
      ),
    )
    await send(remote)
    expect(prompts()).toHaveLength(1)
    expect(session().error).toMatch(/compaction.*draft/i)
    expect(session().items).toEqual([])
    expect(useDraftsStore.getState().get(KEY).text).toBe('PHX-message')
  })
})

it.each([UNKNOWN_OUTCOME, `Studio: controlled by ${PI_BUSY}`, 'No API key found for anthropic.'])(
  'reports %s without claiming non-delivery or issuing a new command',
  async (error) => {
    hostLane('idle')
    const prompts = answers(refused(error))
    await send(true)
    expect(prompts()).toHaveLength(1)
    expect(session().error).toBe(error)
    expect(session().items).toEqual([])
    expect(useDraftsStore.getState().get(KEY).text).toBe('PHX-message')
  },
)
