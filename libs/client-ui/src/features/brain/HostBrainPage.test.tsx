// @vitest-environment jsdom
import type { HostCapability } from '@shared/remote-host'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { HostBrainRequest } from '@shared/host-brain-request'
import { NavigationProvider } from '@/navigation/Navigation'
import { COMPACT_PLATFORM, PlatformProvider } from '@/platform/Platform'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { BrainPage } from './BrainPage'
import { mockBrainStatus } from './mockBrainData'

function createHostInvoke() {
  const { agent, ...status } = mockBrainStatus()
  const { folder: _folder, ...hostAgent } = agent
  const sharedStatus = {
    ...status,
    agent: { ...hostAgent, run: null },
    jobs: [],
    prefs: { ...status.prefs, enabled: true },
    ownerId: null,
  }
  let finishTell: (result: null) => void = () => {}
  const hostInvoke = vi.fn(async ({ hostId }: { hostId: string }, request: HostBrainRequest) => {
    switch (request.method) {
      case 'brain:status':
        return sharedStatus
      case 'brain:overview':
        return { nodes: [], links: [], ended: [], truncated: false, centerId: null }
      case 'brain:tidyChanges':
        return { items: [], revision: status.revision }
      case 'brain:tell':
        return new Promise<null>((resolve) => {
          finishTell = resolve
        })
      case 'brain:laneShow':
        return {
          entries: [
            {
              id: 'same-entry',
              role: 'assistant',
              text: hostId === 'harbor' ? 'Harbor' : 'Ledger',
            },
          ],
          dialogs: [],
          controller: null,
          running: false,
          turn: null,
          messaging: false,
          next: null,
          fence: 1,
        }
      default:
        throw new Error('Unexpected Brain method')
    }
  })
  return { hostInvoke, finishTell: () => finishTell(null) }
}

function createFixture() {
  const previous = useRemoteLanesStore.getState()
  const ready = {
    state: 'ready' as const,
    connectionToken: 'same-epoch',
    brain: true,
    brainAccess: ['read', 'control', 'evidence', 'configure'] as const,
    capabilities: ['sessions.control'] as HostCapability[],
    repositories: [],
    lanes: [],
  }
  const { hostInvoke, finishTell } = createHostInvoke()
  const approvals = vi.fn(async ({ hostId }: { hostId: string }) => [
    {
      confirmId: 'same-approval',
      title: hostId === 'harbor' ? 'Harbor approval' : 'Ledger approval',
      message: 'Allow one read?',
      expiresAt: Date.now() + 30_000,
    },
  ])
  const answer = vi.fn(async () => {})
  const legacy = vi.fn()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', {
    invoke: legacy,
    hostBrain: { invoke: hostInvoke, approvals, answer },
  })
  useRemoteLanesStore.setState({ hosts: { harbor: ready, ledger: ready }, snapshotStatus: 'ready' })
  const node = document.createElement('div')
  document.body.append(node)
  const root = createRoot(node)
  const render = async (machine: string) => {
    await act(async () =>
      root.render(
        <NavigationProvider
          value={{ location: { to: 'page', page: 'brain', machine }, navigate: vi.fn() }}
        >
          <PlatformProvider value={COMPACT_PLATFORM}>
            <BrainPage />
          </PlatformProvider>
        </NavigationProvider>,
      ),
    )
  }
  const click = async (label: string) => {
    const button = [...node.querySelectorAll('button')].find(
      (button) => button.textContent === label,
    )
    expect(button).toBeDefined()
    await act(async () => button!.click())
  }
  const restore = () => {
    act(() => root.unmount())
    node.remove()
    useRemoteLanesStore.setState(previous)
    vi.unstubAllGlobals()
  }
  return {
    render,
    click,
    node,
    ready,
    answer,
    hostInvoke,
    legacy,
    finishTell,
    restore,
  }
}

it('drops a late Tell when the compact surface switches between Hosts with colliding IDs', async () => {
  const { render, click, node, hostInvoke, legacy, finishTell, restore } = createFixture()
  try {
    await render('harbor')
    const draft = node.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      set.call(draft, 'Harbor')
      draft.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('Tell Brain Agent')
    expect(hostInvoke).toHaveBeenCalledWith(
      { hostId: 'harbor', connectionToken: 'same-epoch' },
      { method: 'brain:tell', args: ['Harbor'] },
    )
    await render('ledger')
    await act(async () => finishTell())
    expect(node.querySelector('textarea')?.value).toBe('')
    expect(node.querySelector('[aria-label="Transcript"]')).toBeNull()
    await click('Brain Agent')
    expect(node.querySelector('[aria-label="Transcript"]')?.textContent).toContain('Ledger')
    expect(node.querySelector('[aria-label="Transcript"]')?.textContent).not.toContain('Harbor')
    expect(
      hostInvoke.mock.calls.filter(([, request]) => request.method === 'brain:tell'),
    ).toHaveLength(1)
    expect(legacy.mock.calls.filter(([method]) => String(method).startsWith('brain:'))).toEqual([])
  } finally {
    restore()
  }
})

it('answers only the selected Host’s approval and clears the Agent on grant loss', async () => {
  const { render, click, node, answer, ready, restore } = createFixture()
  try {
    await render('harbor')
    expect(node.textContent).toContain('Harbor approval')
    await render('ledger')
    expect(node.textContent).not.toContain('Harbor approval')
    expect(node.textContent).toContain('Ledger approval')
    await click('Approve once')
    expect(answer).toHaveBeenCalledExactlyOnceWith(
      { hostId: 'ledger', connectionToken: 'same-epoch' },
      'same-approval',
      true,
    )
    await click('Brain Agent')
    expect(node.querySelector('[aria-label="Transcript"]')?.textContent).toContain('Ledger')
    await act(async () =>
      useRemoteLanesStore.setState({
        hosts: { harbor: ready, ledger: { ...ready, brainAccess: [] } },
      }),
    )
    expect(node.querySelector('[aria-label="Transcript"]')).toBeNull()
    expect(node.textContent).not.toContain('Ledger approval')
    expect(node.textContent).toContain('You do not have access')
  } finally {
    restore()
  }
})
