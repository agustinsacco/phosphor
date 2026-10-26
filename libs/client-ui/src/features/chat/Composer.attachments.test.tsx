// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { hostResourceKey } from '@shared/remote-host'
import { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { installMockPhosphor } from '@/dev/mockPhosphor'
import { useChatStore } from '@/stores/chat'
import { useSessionsStore } from '@/stores/sessions'
import { useDraftsStore } from '@/stores/drafts'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { Composer } from './Composer'

let root: Root
let container: HTMLDivElement
const key = hostResourceKey(
  { kind: 'remote', hostId: MOCK_HOST_ID },
  'session',
  mockRemoteInfo.laneId ?? '',
)
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  window.matchMedia = vi
    .fn()
    .mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  installMockPhosphor()
  useChatStore.setState({ sessions: {} })
  useChatStore.getState().ensure(mockRemoteInfo.sessionId)
  useSessionsStore.setState({
    live: {
      [mockRemoteInfo.sessionId]: {
        phosphorId: mockRemoteInfo.sessionId,
        workspacePath: mockRemoteInfo.workspacePath,
        target: mockRemoteInfo.target,
        laneId: mockRemoteInfo.laneId,
      },
    },
  })
  const hosts = structuredClone(mockRemoteHosts)
  const host = hosts[MOCK_HOST_ID]
  if (!host?.lanes[0]?.control.controller) throw new Error('fixture')
  host.capabilities.push('workspaces.write')
  host.lanes[0].control.controller.self = true
  useRemoteLanesStore.setState({ hosts })
  useDraftsStore.setState({
    hydrated: false,
    drafts: {
      [key]: {
        text: 'read this',
        attachments: [
          { kind: 'file', name: 'a.pdf', size: 3, path: '', mime: 'application/pdf', data: 'YWJj' },
        ],
      },
    },
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  useDraftsStore.getState().clear(key)
})
async function draw() {
  await act(async () =>
    root.render(
      <Composer
        sessionId={mockRemoteInfo.sessionId}
        workspacePath={mockRemoteInfo.workspacePath}
      />,
    ),
  )
}
async function send() {
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.click(),
  )
}
it('uploads before prompting and uses the Host path, never the picked local path', async () => {
  const invoke = vi
    .spyOn(window.phosphor, 'invoke')
    .mockImplementation(async (...args) =>
      args[0] === 'hosts:uploadAttachments' ? ['/host/attachments/a.pdf'] : undefined,
    )
  const pi = vi
    .spyOn(window.phosphor, 'piCommand')
    .mockResolvedValue({ type: 'response', command: 'prompt', success: true })
  await draw()
  await send()
  expect(invoke).toHaveBeenCalledWith('hosts:uploadAttachments', mockRemoteInfo.sessionId, [
    { name: 'a.pdf', mime: 'application/pdf', data: 'YWJj' },
  ])
  expect(pi).toHaveBeenCalledWith(mockRemoteInfo.sessionId, {
    type: 'prompt',
    message: 'read this\n\n<attached-files>\n/host/attachments/a.pdf\n</attached-files>',
  })
  expect(useDraftsStore.getState().get(key).attachments).toEqual([])
})
it('never prompts on upload uncertainty, preserves text and releases document bytes', async () => {
  vi.spyOn(window.phosphor, 'invoke').mockRejectedValue(
    new Error('Upload not confirmed. Attach again.'),
  )
  const pi = vi.spyOn(window.phosphor, 'piCommand')
  await draw()
  await send()
  expect(pi.mock.calls.filter(([, op]) => op.type === 'prompt')).toEqual([])
  expect(useDraftsStore.getState().get(key)).toMatchObject({ text: 'read this', attachments: [] })
  expect(useChatStore.getState().sessions[mockRemoteInfo.sessionId]?.items).toEqual([])
})
it('requires both ready capabilities and controller status for attachment UI and sending', async () => {
  const pi = vi.spyOn(window.phosphor, 'piCommand')
  const invoke = vi.spyOn(window.phosphor, 'invoke')
  const hosts = structuredClone(mockRemoteHosts)
  useRemoteLanesStore.setState({ hosts })
  await draw()
  expect(container.querySelector('[aria-label="Attach files"]')).toBeNull()
  await send()
  expect(invoke.mock.calls.some(([channel]) => channel === 'hosts:uploadAttachments')).toBe(false)
  expect(pi.mock.calls.some(([, op]) => op.type === 'prompt')).toBe(false)
})

it('keeps the remote image draft intact when main refuses the encoded frame', async () => {
  const image = { kind: 'image' as const, name: 'large.png', mimeType: 'image/png', data: 'YWJj' }
  useDraftsStore.setState({ drafts: { [key]: { text: 'read this', attachments: [image] } } })
  vi.spyOn(window.phosphor, 'piCommand').mockResolvedValue({
    type: 'response',
    command: 'prompt',
    success: false,
    error: 'Image too large for a remote lane.',
  })
  await draw()
  await send()
  expect(useDraftsStore.getState().get(key)).toMatchObject({
    text: 'read this',
    attachments: [image],
  })
  expect(useChatStore.getState().sessions[mockRemoteInfo.sessionId]?.items).toEqual([])
})

it.each([
  { stage: 'upload', success: true },
  { stage: 'upload', success: false },
  { stage: 'receipt', success: true },
  { stage: 'receipt', success: false },
])(
  'preserves concurrent edits during deferred $stage with success=$success',
  async ({ stage, success }) => {
    let resolve!: (value: boolean) => void
    const pending = new Promise<boolean>((done) => {
      resolve = done
    })
    vi.spyOn(window.phosphor, 'invoke').mockImplementation(async (...args) => {
      if (args[0] !== 'hosts:uploadAttachments') return undefined
      if (stage === 'upload' && !(await pending)) throw new Error('unknown')
      return ['/host/a.pdf']
    })
    vi.spyOn(window.phosphor, 'piCommand').mockImplementation(async () => ({
      type: 'response',
      command: 'prompt',
      success: stage === 'receipt' ? await pending : true,
      error: 'refused',
    }))
    await draw()
    await send()
    const added = { kind: 'file' as const, name: 'new.pdf', size: 3, path: '', data: 'ZGVm' }
    act(() => {
      useDraftsStore.getState().setText(key, 'next task')
      useDraftsStore
        .getState()
        .setAttachments(key, [...useDraftsStore.getState().get(key).attachments, added])
    })
    await act(async () => {
      resolve(success)
      await pending
    })
    expect(useDraftsStore.getState().get(key)).toMatchObject({
      text: 'next task',
      attachments: [added],
    })
  },
)

it.each(['!pwd', '!!pwd'])(
  'refuses remote shell input %s before clearing the draft',
  async (text) => {
    useDraftsStore.setState({ drafts: { [key]: { text, attachments: [] } } })
    const pi = vi.spyOn(window.phosphor, 'piCommand')
    await draw()
    await send()
    expect(pi.mock.calls.some(([, op]) => op.type === 'bash' || op.type === 'prompt')).toBe(false)
    expect(useDraftsStore.getState().get(key).text).toBe(text)
    expect(useChatStore.getState().sessions[mockRemoteInfo.sessionId]?.error).toBe(
      'Not available on remote lanes yet.',
    )
    expect(container.textContent).not.toContain('runs in your shell')
  },
)

it.each([
  ['mac', 'bee-a', 'mac'],
  ['bee-a', 'bee-b', 'bee-a'],
])('slash commands and input drafts follow session switches %j', async (...sequence) => {
  const original = useSessionsStore.getState().live[mockRemoteInfo.sessionId]!
  useSessionsStore.setState({
    live: {
      mac: { phosphorId: 'mac', workspacePath: '/mac' },
      'bee-a': { ...original, phosphorId: 'bee-a' },
      'bee-b': {
        ...original,
        phosphorId: 'bee-b',
        laneId: 'another-lane',
        workspacePath: `host:${MOCK_HOST_ID}/another-repo`,
      },
    },
  })
  for (const id of ['mac', 'bee-a', 'bee-b']) {
    useChatStore.getState().ensure(id)
    useChatStore
      .getState()
      .setCommands(id, [
        { name: `only-${id}`, description: `Command for ${id}`, source: 'extension' },
      ])
  }
  vi.spyOn(window.phosphor, 'piCommand').mockImplementation(async (id, op) => ({
    type: 'response',
    command: op.type,
    success: true,
    data:
      op.type === 'get_commands'
        ? {
            commands: [
              { name: `only-${id}`, description: `Command for ${id}`, source: 'extension' },
            ],
          }
        : undefined,
  }))
  for (const id of sequence) {
    const entry = useSessionsStore.getState().live[id]!
    const draftKey =
      entry.target?.kind === 'remote'
        ? hostResourceKey(entry.target, 'session', entry.laneId!)
        : `session:${id}`
    useDraftsStore.getState().setText(draftKey, '')
    await act(async () =>
      root.render(<Composer key={id} sessionId={id} workspacePath={entry.workspacePath} />),
    )
    const field = container.querySelector('textarea')!
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(field, '/')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.textContent).toContain(`/only-${id}`)
    for (const other of ['mac', 'bee-a', 'bee-b'].filter((x) => x !== id))
      expect(container.textContent).not.toContain(`/only-${other}`)
  }
})

it('queues a remote follow-up typed while the steer before it awaits its receipt', async () => {
  useDraftsStore.setState({ drafts: { [key]: { text: 'PHX-steered', attachments: [] } } })
  useChatStore.setState((s) => ({
    sessions: {
      ...s.sessions,
      [mockRemoteInfo.sessionId]: { ...s.sessions[mockRemoteInfo.sessionId]!, isStreaming: true },
    },
  }))
  const receipts: (() => void)[] = []
  const pi = vi
    .spyOn(window.phosphor, 'piCommand')
    .mockImplementation(
      (_id, op) =>
        new Promise((done) =>
          receipts.push(() => done({ type: 'response', command: op.type, success: true })),
        ),
    )
  await draw()
  const click = (name: string) =>
    act(async () =>
      [...container.querySelectorAll('button')].find((b) => b.textContent === name)?.click(),
    )
  await click('Steer now')
  act(() => useDraftsStore.getState().setText(key, 'PHX-followed'))
  await click('Queue follow-up')
  // A second press of the same follow-up while it is in flight is not a resend.
  await click('Queue follow-up')
  const prompts = pi.mock.calls.filter(([, op]) => op.type === 'prompt').map(([, op]) => op)
  expect(prompts).toEqual([
    { type: 'prompt', message: 'PHX-steered', streamingBehavior: 'steer' },
    { type: 'prompt', message: 'PHX-followed', streamingBehavior: 'followUp' },
  ])
  await act(async () => receipts.forEach((done) => done()))
  expect(useDraftsStore.getState().get(key).text).toBe('')
})
