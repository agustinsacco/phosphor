// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { MachineTelemetry } from '@shared/host-protocol-telemetry'
import type { HostCapability } from '@shared/remote-host'
import { MOCK_HOST_ID, mockRemoteHosts } from '@/dev/mockRemoteLanes'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { TELEMETRY_POLL_MS, setTelemetryAllowed, useTelemetry } from '@/stores/telemetry'
import { HostTelemetryButton } from './HostTelemetryButton'

const hostId = MOCK_HOST_ID
type Invoke = (hostId: string) => Promise<MachineTelemetry | null>
let invoke: Mock<Invoke>
let root: Root
let el: HTMLDivElement

/** The mock Host with whatever grants the case needs. */
function seedHost(capabilities: readonly HostCapability[]): void {
  const view = structuredClone(mockRemoteHosts[hostId]!)
  view.capabilities = [...view.capabilities, ...capabilities]
  useRemoteLanesStore.setState({ hosts: { [hostId]: view } })
}

/** Half the machine busy, two of ours running. `busy`/`cpuSec` step each round. */
function sample(round = 0): MachineTelemetry {
  return {
    at: 1_700_000_000_000 + round * TELEMETRY_POLL_MS,
    uptimeSec: 5_000 + round * TELEMETRY_POLL_MS,
    load: [1, 1, 1],
    cpu: {
      perCore: [
        { idle: 100 + round * 50, busy: 50 + round * 50 },
        { idle: 100 + round * 50, busy: 50 + round * 50 },
      ],
    },
    mem: { total: 1000, free: 200, used: 600, cache: 200, swapTotal: 100, swapUsed: 20 },
    disk: { total: 5_000, free: 1_000 },
    census: {
      kinds: [
        { kind: 'pi', procs: 2, cpuSec: 20 + round, rss: 500 },
        { kind: 'host', procs: 1, cpuSec: 5 + round, rss: 100 },
      ],
      procs: [],
    },
  }
}

const button = (): HTMLButtonElement | undefined =>
  document.querySelector<HTMLButtonElement>('button[aria-label="Machine telemetry"]') ?? undefined
const text = (): string => document.body.textContent ?? ''

async function mount(): Promise<void> {
  await act(async () => root.render(<HostTelemetryButton />))
}
async function click(target: Element): Promise<void> {
  await act(async () => (target as HTMLElement).click())
}
/** Let the loop's read settle and its pause expire `times` times. */
async function poll(times = 1): Promise<void> {
  for (let i = 0; i < times; i++)
    await act(async () => void vi.advanceTimersByTimeAsync(TELEMETRY_POLL_MS))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let round = 0
  invoke = vi.fn<Invoke>(async () => sample(round++))
  Object.defineProperty(window, 'phosphor', { configurable: true, value: { invoke } })
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
  seedHost(['skills.read'])
  useTelemetry.setState({ byHost: {} })
  setTelemetryAllowed(true)
})

afterEach(() => {
  act(() => root.unmount())
  el.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('the bar machine button', () => {
  it('shows nothing where there is no Host to ask', async () => {
    useRemoteLanesStore.setState({ hosts: {} })
    await mount()
    expect(button()).toBeUndefined()
  })

  it('reads the Host only while the popover is open', async () => {
    await mount()
    expect(button()).toBeDefined()
    expect(invoke).not.toHaveBeenCalled()

    await click(button()!)
    await poll(2)
    const whileOpen = invoke.mock.calls.length
    expect(whileOpen).toBeGreaterThanOrEqual(2)

    await click(button()!)
    await poll(3)
    expect(invoke.mock.calls.length).toBe(whileOpen)
  })

  it('shows a rate only once it has two samples to compare', async () => {
    await mount()
    await click(button()!)
    // The first read has landed and there is nothing to rate it against: the
    // popover says so per core rather than drawing 0%.
    await act(async () => void vi.advanceTimersByTimeAsync(0))
    expect(text()).toContain('needs one more sample to measure')
    expect(text()).not.toContain('50%')
    await poll(1)
    expect(text()).toContain('50%')
  })

  it('shows what Phosphor is running, in its own words', async () => {
    await mount()
    await click(button()!)
    await poll(2)
    expect(text()).toContain('phosphor')
    expect(text()).toContain('3 procs')
    expect(text()).toContain('600 B of 1000 B')
  })

  it('says the machine will not report rather than drawing zeros', async () => {
    useTelemetry.setState({ byHost: {} })
    seedHost([])
    await mount()
    await click(button()!)
    await poll(2)
    expect(text()).toContain('does not offer machine telemetry')
    expect(text()).not.toContain('50%')
    expect(invoke).not.toHaveBeenCalled()
  })
})
