// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useChatStore, type ChatSession } from '@/stores/chat'
import { useDraftsStore } from '@/stores/drafts'
import { ContinueButton } from './ContinueButton'

const piCommand = vi.fn()
let root: Root
let container: HTMLDivElement

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  piCommand.mockReset().mockResolvedValue({ success: true })
  Object.defineProperty(window, 'phosphor', { configurable: true, value: { piCommand } })
  useChatStore.setState({ sessions: {} })
  useChatStore.getState().ensure('s1')
  useChatStore.getState().ensure('s2')
  useDraftsStore.setState({ drafts: {} })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(): HTMLButtonElement {
  act(() => root.render(<ContinueButton sessionId="s1" />))
  return container.querySelector('button')!
}

function patch(patch: Partial<ChatSession>): void {
  useChatStore.setState((s) => ({
    sessions: { ...s.sessions, s1: { ...s.sessions.s1!, ...patch } },
  }))
}

describe('ContinueButton', () => {
  it('sends only continue to its session and leaves text, files and images staged', async () => {
    useDraftsStore.setState({
      drafts: {
        'session:s1': {
          text: '!do not send this draft',
          attachments: [
            { kind: 'image', data: 'aGVsbG8=', mimeType: 'image/png', name: 'image.png' },
            { kind: 'file', path: '/workspace/notes.txt', name: 'notes.txt', size: 5 },
          ],
        },
      },
    })
    const drafts = useDraftsStore.getState().drafts
    const button = render()
    expect(button.disabled).toBe(false)
    expect(button.getAttribute('aria-label')).toBe('Continue')
    expect(button.dataset.tooltip).toBe('Continue')
    expect(button.dataset.tooltipDescription).toContain('Sends "continue"')
    expect(button.dataset.tooltipDescription).toContain('Keeps your draft')

    await act(async () => button.click())

    expect(piCommand).toHaveBeenCalledExactlyOnceWith('s1', {
      type: 'prompt',
      message: 'continue',
    })
    expect(useChatStore.getState().sessions.s1!.items).toEqual([
      expect.objectContaining({ kind: 'user', text: 'continue', images: undefined }),
    ])
    expect(useChatStore.getState().sessions.s2!.items).toEqual([])
    expect(useDraftsStore.getState().drafts).toBe(drafts)
    expect(button.disabled).toBe(true)
  })

  it.each<Partial<ChatSession>>([
    { resuming: true },
    { isStreaming: true },
    { isCompacting: true },
    { promptSentAt: 123 },
  ])('cannot send while busy: %j', async (state) => {
    patch(state)
    const button = render()
    expect(button.disabled).toBe(true)
    await act(async () => button.click())
    expect(piCommand).not.toHaveBeenCalled()
  })

  it('cannot send before the session exists', () => {
    useChatStore.getState().remove('s1')
    expect(render().disabled).toBe(true)
  })

  it('guards duplicate clicks before a render, including after an earlier error', async () => {
    patch({ error: 'Previous request failed' })
    const button = render()
    await act(async () => {
      button.click()
      button.click()
    })
    expect(piCommand).toHaveBeenCalledTimes(1)
    expect(useChatStore.getState().sessions.s1!.error).toBeNull()
    expect(button.disabled).toBe(true)
    act(() => useChatStore.getState().applyEvent('s1', { type: 'agent_end', messages: [] }))
    expect(button.disabled).toBe(false)
  })

  it.each(['envelope', 'transport'])('surfaces a %s failure and allows retry', async (failure) => {
    if (failure === 'envelope') {
      piCommand.mockResolvedValue({ success: false, error: 'Cannot continue' })
    } else {
      piCommand.mockRejectedValue(new Error('Cannot continue'))
    }
    const button = render()
    await act(async () => button.click())
    expect(useChatStore.getState().sessions.s1!.error).toBe('Cannot continue')
    expect(button.disabled).toBe(false)
    piCommand.mockResolvedValue({ success: true })
    await act(async () => button.click())
    expect(piCommand).toHaveBeenCalledTimes(2)
  })
})

it('remote continue waits for the receipt and Host echo, with no optimistic duplicate', async () => {
  const { useSessionsStore } = await import('@/stores/sessions')
  const { useRemoteLanesStore } = await import('@/stores/remoteLanes')
  const { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } = await import('@/dev/mockRemoteLanes')
  const hosts = structuredClone(mockRemoteHosts)
  hosts[MOCK_HOST_ID]!.lanes[0]!.control.controller = { self: true, label: 'You', connected: true }
  useRemoteLanesStore.setState({ hosts })
  useSessionsStore.setState({ live: { s1: { ...mockRemoteInfo, phosphorId: 's1' } } })
  let finish: ((value: { success: boolean }) => void) | undefined
  piCommand.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const button = render()
  await act(async () => {
    button.click()
    button.click()
  })
  expect(piCommand).toHaveBeenCalledOnce()
  expect(button.disabled).toBe(true)
  expect(useChatStore.getState().sessions.s1?.items).toEqual([])
  await act(async () => finish?.({ success: true }))
  expect(useChatStore.getState().sessions.s1?.items).toEqual([])
  act(() => useRemoteLanesStore.setState({ hosts: {} }))
  expect(button.disabled).toBe(true)
  useSessionsStore.setState({ live: {} })
})
