// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ErrorBlock, MessageItemView } from './MessageItem'
import { useSessionsStore } from '@/stores/sessions'
import { useChatUiStore } from './uiState'
import { useChatStore } from '@/stores/chat'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { mockRemoteHosts, MOCK_HOST_ID, mockRemoteInfo } from '@/dev/mockRemoteLanes'
vi.mock('@/components/markdown/Markdown', () => ({
  Markdown: ({ text }: { text: string }) => <span>{text}</span>,
}))
it.each([
  ['mac', 'bee-a', 'mac'],
  ['bee-a', 'bee-b', 'bee-a'],
])('error remedy follows current target across %j', async (...sequence) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const invoke = vi.fn().mockResolvedValue({ awsProfile: 'mac-profile' })
  vi.stubGlobal('phosphor', { invoke })
  useSessionsStore.setState({
    live: {
      mac: { phosphorId: 'mac', workspacePath: '/mac' },
      'bee-a': { ...mockRemoteInfo, phosphorId: 'bee-a' },
      'bee-b': {
        ...mockRemoteInfo,
        phosphorId: 'bee-b',
        workspacePath: 'host:other/lane:other-lane',
        target: { kind: 'remote', hostId: 'other' },
      },
    },
  })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    for (const id of sequence) {
      invoke.mockClear()
      await act(async () => {
        useSessionsStore.setState({ activeSessionId: id })
        root.render(<ErrorBlock key={id} message="OAuth refresh token rejected" />)
      })
      expect(container.textContent).toContain(id === 'mac' ? 'Run pi /login' : 'Sign in on')
      if (id !== 'mac') {
        expect(invoke).not.toHaveBeenCalled()
        expect(container.textContent).not.toContain('Run pi /login')
        expect(container.textContent).not.toContain('mac-profile')
      }
    }
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})
it('remote user message rewind and fork are disabled, never opening a dead picker', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const piCommand = vi.fn()
  vi.stubGlobal('phosphor', { piCommand })
  useSessionsStore.setState({ live: { remote: { ...mockRemoteInfo, phosphorId: 'remote' } } })
  const picker = vi.spyOn(useChatUiStore.getState(), 'openForkPicker')
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    act(() =>
      root.render(
        <MessageItemView
          row={{ kind: 'item', id: 'user', item: { id: 'user', kind: 'user', text: 'Prompt' } }}
          sessionId="remote"
          tools={{}}
          hideThinking={false}
        />,
      ),
    )
    const buttons = container.querySelectorAll<HTMLButtonElement>(
      '[data-tooltip="Not available on remote lanes yet."]',
    )
    expect(buttons).toHaveLength(2)
    for (const button of buttons) {
      expect(button.disabled).toBe(true)
      await act(async () => button.click())
    }
    expect(piCommand).not.toHaveBeenCalled()
    expect(picker).not.toHaveBeenCalled()
  } finally {
    act(() => root.unmount())
    container.remove()
    picker.mockRestore()
    vi.unstubAllGlobals()
  }
})

it.each(['idle', 'working', 'stopped', 'failed', 'needs-input'] as const)(
  'failed-turn retry respects authoritative Host activity %s',
  async (activity) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const piCommand = vi.fn(async () => ({ success: true }))
    vi.stubGlobal('phosphor', { piCommand })
    useSessionsStore.setState({
      live: { remote: { ...mockRemoteInfo, phosphorId: 'remote' } },
      activeSessionId: 'remote',
    })
    const hosts = structuredClone(mockRemoteHosts)
    hosts[MOCK_HOST_ID]!.lanes[0] = { ...hosts[MOCK_HOST_ID]!.lanes[0]!, activity }
    hosts[MOCK_HOST_ID]!.lanes[0]!.control.controller = {
      self: true,
      connected: true,
      label: 'This Desktop',
    }
    useRemoteLanesStore.setState({ hosts })
    useChatStore.getState().ensure('remote')
    const message = 'OAuth refresh token rejected'
    useChatStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        remote: {
          ...s.sessions.remote!,
          isStreaming: false,
          items: [
            { id: 'u', kind: 'user', text: 'retry me' },
            {
              id: 'a',
              kind: 'assistant',
              streaming: false,
              blocks: [],
              stopReason: 'error',
              errorMessage: message,
            },
          ],
        },
      },
    }))
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try {
      act(() => root.render(<ErrorBlock sessionId="remote" message={message} />))
      const retry = [...container.querySelectorAll('button')].find(
        (b) => b.textContent === 'Retry failed turn',
      )
      expect(!!retry).toBe(activity === 'idle')
      if (retry) await act(async () => retry.click())
      expect(piCommand).toHaveBeenCalledTimes(activity === 'idle' ? 1 : 0)
    } finally {
      act(() => root.unmount())
      container.remove()
      vi.unstubAllGlobals()
    }
  },
)
