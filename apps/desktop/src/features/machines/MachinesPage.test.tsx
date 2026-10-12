// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useMachinesStore, type MachineTab } from '@/stores/machines'
import { MachinesPage } from './MachinesPage'
import { MachineFilterBar } from './MachineSidebar'
import { RunOnPicker } from './RunOnPicker'

// This computer's Logins tab is Settings → Accounts itself, which has its own tests.
vi.mock('@/features/settings/tabs/AccountsTab', () => ({
  AccountsTab: () => <h2>Accounts</h2>,
}))

const ANSWERS: Record<string, unknown> = {
  'pi:health': { ok: true, version: '0.87.1', minVersion: '0.87.0' },
  'pi:subscriptionAuth': [
    { id: 'openai-codex', name: 'ChatGPT (Codex)', status: 'ready' },
    { id: 'xai', name: 'xAI', status: 'not_ready' },
  ],
  'packages:claudeStatus': {
    binary: { found: true, version: '2.1.283' },
    auth: { ok: true, loggedIn: true },
  },
  'packages:list': [{ name: '@saccolabs/pi-claude-cli', version: '0.10.0' }],
}

const container = document.createElement('div')
const root = createRoot(container)

beforeEach(() => {
  vi.stubGlobal('phosphor', {
    platform: 'darwin',
    invoke: vi.fn((channel: string) => Promise.resolve(ANSWERS[channel])),
  })
  useMachinesStore.getState().applyPreview(true)
})

afterEach(() => {
  act(() => root.render(null))
  useMachinesStore.getState().applyPreview(false)
  vi.unstubAllGlobals()
})

async function render(node: React.ReactNode): Promise<string> {
  await act(async () => root.render(node))
  return container.textContent ?? ''
}

it('lists this computer from real data beside the made-up machines', async () => {
  const text = await render(<MachinesPage />)
  expect(text).toContain('bee1 and bee2 are not real')
  const rows = [...container.querySelectorAll('[data-testid="machine-row"]')]
  expect(rows.map((row) => row.getAttribute('data-machine'))).toEqual(['local', 'bee1', 'bee2'])
  expect(rows[0]?.textContent).toContain('pi 0.87.1')
  expect(rows[0]?.textContent).toContain('ChatGPT (Codex) ✓')
  expect(rows[0]?.textContent).toContain('Claude Code ✓')
  expect(rows[0]?.textContent).not.toContain('xAI')
  expect(rows[2]?.textContent).toContain('down 3 h')
})

it.each(['bee1', 'bee2', 'local'])('renders every tab of %s', async (id) => {
  for (const tab of ['overview', 'lanes', 'dependencies', 'logins'] as MachineTab[]) {
    act(() => useMachinesStore.getState().show({ kind: 'machine', id, tab }))
    const text = await render(<MachinesPage />)
    const selected = container.querySelector('[role="tab"][aria-selected="true"]')
    expect(selected?.textContent?.toLowerCase()).toBe(tab)
    // Every tab keeps saying whether the machine is up.
    if (id === 'bee2') expect(text).toContain('down 3 h')
    if (id === 'bee1') expect(text).toContain('up · seen 12 s ago')
    if (tab === 'lanes' && id === 'bee1') {
      expect(container.querySelectorAll('[data-testid="remote-lane-row"]')).toHaveLength(3)
    }
    if (tab === 'logins') {
      expect(text).toContain(id === 'local' ? 'Accounts' : 'The credential stays on the Host')
    }
    if (tab === 'dependencies' && id === 'local') {
      expect(text).toContain('0.10.0')
      expect(text).toContain('2.1.283')
    }
  }
})

it("keeps a made-up machine's actions disabled", async () => {
  act(() => useMachinesStore.getState().show({ kind: 'machine', id: 'bee1', tab: 'dependencies' }))
  await render(<MachinesPage />)
  const actions = [...container.querySelectorAll('button')].filter((button) =>
    /^(Upgrade|Update) to/.test(button.textContent ?? ''),
  )
  expect(actions.length).toBeGreaterThan(0)
  expect(actions.every((button) => button.disabled)).toBe(true)
})

it('shows a lane on a down machine as what it last reported, with no finish', async () => {
  // Still running when bee2 went quiet: only the machine being down stops the finish.
  useMachinesStore.setState((s) => ({
    lanes: s.lanes.map((lane) => (lane.id === 'bee2-e2e' ? { ...lane, state: 'running' } : lane)),
  }))
  act(() => useMachinesStore.getState().show({ kind: 'lane', id: 'bee2-e2e' }))
  const text = await render(<MachinesPage />)
  expect(text).toContain('bee2 is down')
  const finish = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Pretend it finished',
  )
  expect(finish?.disabled).toBe(true)
})

it('filters the sidebar by machine', async () => {
  await render(<MachineFilterBar />)
  const options = [...container.querySelectorAll('button')]
  expect(options.map((button) => button.textContent)).toEqual(['All', 'This Mac', 'bee1', 'bee2'])
  await act(async () => options[2]?.click())
  expect(useMachinesStore.getState().filter).toBe('bee1')
  expect(options[2]?.getAttribute('aria-pressed')).toBe('true')
})

it('offers only this computer to run a new lane on', async () => {
  await render(<RunOnPicker />)
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="run-on"]')?.click(),
  )
  const rows = [...container.querySelectorAll('[role="menu"] button, button')].filter((button) =>
    /^(This Mac|bee1|bee2)/.test(button.textContent ?? ''),
  )
  expect(
    rows.map((row) => [row.textContent?.slice(0, 7), (row as HTMLButtonElement).disabled]),
  ).toEqual([
    ['This Ma', false],
    ['bee1pre', true],
    ['bee2dow', true],
  ])
})
