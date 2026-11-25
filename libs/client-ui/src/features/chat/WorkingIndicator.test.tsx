// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { SessionStats } from '@shared/rpc'
import { useChatStore } from '@/stores/chat'

// PhosphorLoader reads the reduced-motion preference at module scope.
window.matchMedia = vi.fn().mockReturnValue({
  matches: false,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
}) as unknown as typeof window.matchMedia

const { WorkingIndicator } = await import('./WorkingIndicator')

const T0 = new Date('2026-08-09T15:00:00').getTime()
let root: Root | null = null
let container: HTMLDivElement | null = null

function statsWith(output: number): SessionStats {
  const input = 5_000
  return {
    sessionId: 's1',
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 2,
    tokens: { input, output, cacheRead: 0, cacheWrite: 0, total: input + output },
    cost: 0,
  }
}

function setOutput(output: number): void {
  // Through the store's own actions, so the session keeps the full `ChatSession`
  // shape instead of a hand-built one that drifts whenever the store grows.
  const store = useChatStore.getState()
  store.ensure('s1')
  store.applyEvent('s1', { type: 'agent_start' })
  store.setStats('s1', statsWith(output))
  // Only the run's start is pinned, so elapsed and the rate window are exact.
  useChatStore.setState((s) => ({
    sessions: { ...s.sessions, s1: { ...s.sessions['s1']!, agentStartedAt: T0 - 20_000 } },
  }))
}

function mount(): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(<WorkingIndicator sessionId="s1" />)
  })
  return container
}

/** One second of the run, with the model having produced `output` tokens by now. */
async function second(output: number): Promise<void> {
  await act(async () => {
    setOutput(output)
    vi.advanceTimersByTime(1000)
  })
}

const speed = (): string | null =>
  container?.querySelector('[data-testid="working-speed"]')?.textContent ?? null

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
  vi.useRealTimers()
  useChatStore.setState({ sessions: {} })
})

describe('WorkingIndicator throughput', () => {
  it('reports the tokens per second the model is handing over', async () => {
    const el = mount()
    // 60 tokens each second, measured over a window wider than one step.
    await second(0)
    await second(60)
    await second(120)
    await second(180)
    expect(speed()).toMatch(/^\d+(\.\d)? tok\/s$/)
    expect(el.textContent).toContain('Working')
  })

  it('loses the figure while a tool runs instead of reporting the wait as a slow model', async () => {
    mount()
    await second(0)
    await second(60)
    await second(120)
    expect(speed()).not.toBeNull()
    // The token count stops moving; four seconds of that is a tool call.
    await second(120)
    await second(120)
    await second(120)
    await second(120)
    await second(120)
    expect(speed()).toBeNull()
  })

  it('shows nothing at all before the run has a stream to measure', async () => {
    mount()
    await second(0)
    expect(speed()).toBeNull()
  })

  it('keeps elapsed and tokens where the e2e harness reads them', async () => {
    mount()
    await second(1_000)
    expect(container?.textContent).toMatch(/21\.0s\s*·\s*6\.0k tokens/)
  })
})
