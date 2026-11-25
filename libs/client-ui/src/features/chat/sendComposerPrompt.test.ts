// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcCommand, RpcResponse, RpcResponseDataMap } from '@shared/rpc'
import { installMockPhosphor } from '@/dev/mockPhosphor'
import { hostLaneSession, mockRemoteInfo } from '@/dev/mockRemoteLanes'
import { useChatStore } from '@/stores/chat'
import { useDraftsStore } from '@/stores/drafts'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { createReceiptGuard } from './receiptGuard'
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
  sendComposerPrompt(
    { sessionId: id, draftKey: KEY, remote, remoteAttachments: false, busyBehavior },
    createReceiptGuard(),
  )
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
  it('an idle lane sends Enter as a plain prompt with its pending bubble', async () => {
    const prompts = answers(accepted('started'))
    await send(false, 'steer')
    expect(prompts()).toEqual([{ type: 'prompt', message: 'PHX-message' }])
    expect(session().items).toMatchObject([{ kind: 'user', text: 'PHX-message', optimistic: true }])
  })

  it('Send steers while the Host reports the lane working and the chat thinks it idle', async () => {
    hostLane('working')
    const prompts = answers(accepted('queued'))
    await send(true)
    expect(prompts()).toEqual([
      { type: 'prompt', message: 'PHX-message', streamingBehavior: 'steer' },
    ])
    expect(session().items).toEqual([])
    expect(session().error).toBeNull()
  })

  it('a modified Enter queues a follow-up while the Host reports the lane working', async () => {
    hostLane('working')
    const prompts = answers(accepted('queued'))
    await send(true, 'followUp')
    expect(prompts()).toEqual([
      { type: 'prompt', message: 'PHX-message', streamingBehavior: 'followUp' },
    ])
  })

  it('a message typed while the last prompt waits for pi steers instead of vanishing', async () => {
    useChatStore.getState().addUserMessage(id, 'first')
    const prompts = answers(accepted('queued'))
    await send(false)
    expect(prompts()).toEqual([
      { type: 'prompt', message: 'PHX-message', streamingBehavior: 'steer' },
    ])
  })
})

describe.each([
  ['This Mac', false],
  ['a Host lane', true],
])('pi refusing a plain prompt because it is processing, on %s', (_, remote) => {
  beforeEach(() => {
    if (remote) hostLane('idle')
  })

  it('goes again once as a follow-up, shows no error and keeps nothing pending', async () => {
    const prompts = answers(refused(PI_BUSY), accepted('queued'))
    await send(remote)
    expect(prompts()).toEqual([
      { type: 'prompt', message: 'PHX-message' },
      { type: 'prompt', message: 'PHX-message', streamingBehavior: 'followUp' },
    ])
    expect(session()).toMatchObject({ error: null, items: [], promptSentAt: null })
    expect(useDraftsStore.getState().get(KEY).text).toBe('')
  })

  it('never shows pi’s text when the follow-up is refused too', async () => {
    answers(refused(PI_BUSY), refused(PI_BUSY))
    await send(remote)
    expect(session().error).toBe('The agent is busy and did not take your message.')
    expect(session().items).toEqual([])
    if (remote) expect(useDraftsStore.getState().get(KEY).text).toBe('PHX-message')
  })
})

it('another refusal reads as a message not sent and returns a Host draft', async () => {
  hostLane('idle')
  const prompts = answers(refused('No API key found for anthropic.'))
  await send(true)
  expect(prompts()).toHaveLength(1)
  expect(session().error).toBe('Message not sent: No API key found for anthropic.')
  expect(session().items).toEqual([])
  expect(useDraftsStore.getState().get(KEY).text).toBe('PHX-message')
})
