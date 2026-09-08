// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { RpcCommand } from '@shared/rpc'
import { useChatStore } from '@/stores/chat'
import { QueueChips } from './QueueChips'

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

const piCommand = vi.fn(async (_id: string, command: RpcCommand) =>
  command.type === 'clear_queue'
    ? { success: true, data: { steering: ['first', 'second'], followUp: [] } }
    : { success: true },
)

let root: Root | null = null
let container: HTMLDivElement | null = null

beforeEach(() => {
  piCommand.mockClear()
  ;(globalThis as unknown as { window: { phosphor: unknown } }).window.phosphor = { piCommand }
  useChatStore.setState({ sessions: {} }, false)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

function queueSteering(texts: string[]): void {
  useChatStore.setState(
    {
      sessions: {
        s1: { queues: { steering: texts, followUp: [] } } as never,
      },
    },
    false,
  )
}

describe('QueueChips', () => {
  it('renders nothing when both queues are empty', () => {
    act(() => root!.render(<QueueChips sessionId="s1" />))
    expect(container!.querySelector('[data-testid="queue-chips"]')).toBeNull()
  })

  it('undoes the clicked steer by draining and re-queueing the rest', async () => {
    queueSteering(['first', 'second'])
    act(() => root!.render(<QueueChips sessionId="s1" />))
    const buttons = container!.querySelectorAll<HTMLButtonElement>('button')
    expect(buttons).toHaveLength(2)

    await act(async () => {
      buttons[0]!.click()
    })

    expect(piCommand.mock.calls.map(([, command]) => command)).toEqual([
      { type: 'clear_queue' },
      { type: 'steer', message: 'second' },
    ])
  })
})
