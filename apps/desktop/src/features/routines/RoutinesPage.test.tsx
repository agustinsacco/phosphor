// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { newRoutine, type Routine, type RoutinesSnapshot } from '@shared/routines'
import { RoutinesPage } from './RoutinesPage'
import { useRoutinesStore } from '@/stores/routines'

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    value: () => ({ matches: false, addEventListener: () => {} }),
    configurable: true,
  })
})

const host = 'host:11111111-1111-4111-8111-111111111111'
const machine = {
  id: host,
  label: 'bee1',
  available: true,
  control: true,
  repositories: [{ id: '0123456789abcdef', name: 'Host repo' }],
}
const local: Routine = {
  ...newRoutine('/local'),
  name: 'Local task',
  instructions: 'Review',
  provider: 'test',
  model: 'model',
  id: 'local',
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  nextAt: null,
  attention: null,
  archived: false,
}
const remote: Routine = {
  ...local,
  id: `${host}/22222222-2222-4222-8222-222222222222`,
  name: 'Remote task',
  workspacePath: 'Host repo',
  machine: { id: host, label: 'bee1', repositoryId: '0123456789abcdef', control: true },
}
const snapshot: RoutinesSnapshot = {
  routines: [local],
  runs: [],
  error: null,
  background: false,
  machines: [machine],
}
let root: Root, container: HTMLDivElement
let changed: (event?: { machine?: string }) => void
const defaultInvoke = async (channel: string, machine?: unknown): Promise<unknown> => {
  if (channel === 'routines:list') return machine ? { ...snapshot, routines: [remote] } : snapshot
  if (channel === 'routines:history') return []
  if (channel === 'pi:listModels') return []
  return null
}
const invoke = vi.fn(defaultInvoke)
beforeEach(() => {
  invoke.mockReset().mockImplementation(defaultInvoke)
  vi.stubGlobal('phosphor', {
    invoke,
    onRoutinesChanged: (cb: (event?: { machine?: string }) => void) => {
      changed = cb
      return () => {}
    },
    onHostsChanged: () => () => {},
  })
  useRoutinesStore.setState({
    snapshot: null,
    machines: [],
    remote: {},
    error: null,
    editorDrafts: {},
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
const click = async (text: string) => {
  const button = Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  )
  expect(button, text).toBeDefined()
  await act(async () => button?.click())
}
it('tags local and remote rows, filters by machine and refreshes on routines-changed', async () => {
  await act(async () => root.render(<RoutinesPage workspacePath="/local" />))
  expect(container.textContent).toContain('This computer')
  expect(container.textContent).toContain('bee1')
  const rows = Array.from(container.querySelectorAll('[data-testid=routine-row]'))
  expect(rows).toHaveLength(2)
  expect(rows[0]?.textContent).toContain('This computer')
  expect(rows[1]?.textContent).toContain('bee1')
  expect(rows[0]?.textContent).toContain('Not run yet')
  expect(rows[0]?.textContent).not.toContain('Open for run history')
  expect(rows[1]?.textContent).toContain('Open for run history')
  expect(rows[1]?.textContent).not.toContain('Not run yet')
  const filter = container.querySelector<HTMLSelectElement>('[aria-label="Machine filter"]')
  await act(async () => {
    if (filter) filter.value = host
    filter?.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(container.querySelectorAll('[data-testid=routine-row]')).toHaveLength(1)
  expect(container.textContent).toContain('Remote task')
  expect(container.textContent).not.toContain('Local task')
  const calls = invoke.mock.calls.length
  await act(async () => changed({ machine: host }))
  expect(invoke.mock.calls.slice(calls)).toEqual([['routines:list', host]])
})
it('requires explicit unattended acknowledgement for Enable on bee1 and fixes the machine', async () => {
  await act(async () => root.render(<RoutinesPage workspacePath="/local" />))
  await click('Remote taskHost repobee1PausedOpen for run history')
  await click('Edit')
  const select = document.querySelector<HTMLSelectElement>('[aria-label="Routine machine"]')
  expect(select?.disabled).toBe(true)
  expect(document.querySelector('[aria-label="Workspace"]')).toBeNull()
  expect(document.querySelector('[aria-label="Routine repository"]')).not.toBeNull()
  const enable = Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent === 'Enable on bee1',
  )
  expect(enable?.disabled).toBe(true)
  const trust = document.querySelector<HTMLInputElement>('input[type=checkbox]')
  await act(async () => trust?.click())
  expect(enable?.disabled).toBe(false)
  await click('Enable on bee1')
  expect(invoke).toHaveBeenCalledWith(
    'routines:save',
    expect.objectContaining({
      trusted: true,
      enabled: true,
      repositoryId: '0123456789abcdef',
    }),
    remote.id,
    1,
    host,
  )
  expect(invoke.mock.calls.some(([c]) => c === 'routines:check')).toBe(false)
})

it('disables enable and run for a remote viewer with the existing read-only hint', async () => {
  invoke.mockImplementationOnce(async () => ({
    ...snapshot,
    machines: [{ ...machine, control: false }],
  }))
  invoke.mockImplementationOnce(async () => ({
    ...snapshot,
    routines: [{ ...remote, trusted: true, machine: { ...remote.machine, control: false } }],
  }))
  await act(async () => root.render(<RoutinesPage workspacePath="/local" />))
  await click('Remote taskHost repobee1PausedOpen for run history')
  const run = Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent === 'Run now',
  )
  expect(run?.disabled).toBe(true)
  expect(run?.getAttribute('data-tooltip')).toBe('Read-only. Take control to send messages.')
  await click('Edit')
  const enable = Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent === 'Enable on bee1',
  )
  expect(enable?.disabled).toBe(true)
  expect(enable?.getAttribute('data-tooltip')).toBe('Read-only. Take control to send messages.')
})

it('does not refresh the selected machine history when another machine changes', async () => {
  const other = 'host:33333333-3333-4333-8333-333333333333'
  const otherMachine = { ...machine, id: other, label: 'bee2' }
  const otherRoutine = {
    ...remote,
    id: remote.id.replace(host, other),
    name: 'Other task',
    machine: { ...remote.machine, id: other, label: 'bee2' },
  }
  invoke.mockImplementation(async (channel, target) => {
    if (channel === 'routines:list')
      return target
        ? { ...snapshot, routines: [target === host ? remote : otherRoutine] }
        : { ...snapshot, machines: [machine, otherMachine] }
    if (channel === 'routines:history') return []
    return null
  })
  await act(async () => root.render(<RoutinesPage workspacePath="/local" />))
  await click('Remote taskHost repobee1PausedOpen for run history')
  const calls = invoke.mock.calls.length
  await act(async () => changed({ machine: other }))
  expect(invoke.mock.calls.slice(calls)).toEqual([['routines:list', other]])
})

const choose = async (label: string, value: string) => {
  const select = document.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)
  expect(select).not.toBeNull()
  await act(async () => {
    select!.value = value
    select!.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
const saveButton = () =>
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Save paused')!
const closeEditor = async () => {
  const close = document.querySelector<HTMLButtonElement>('[role=dialog] [aria-label=Close]')
  await act(async () => close!.click())
}

it('resumes a new remote draft with its machine and repository and resets both with input', async () => {
  await act(async () => root.render(<RoutinesPage workspacePath="/local" />))
  await click('New routine')
  await choose('Routine machine', host)
  await choose('Routine repository', machine.repositories[0]!.id)
  await closeEditor()
  await click('Resume draft')
  expect(document.querySelector<HTMLSelectElement>('[aria-label="Routine machine"]')?.value).toBe(
    host,
  )
  expect(
    document.querySelector<HTMLSelectElement>('[aria-label="Routine repository"]')?.value,
  ).toBe(machine.repositories[0]!.id)
  await click('Reset')
  expect(document.querySelector<HTMLSelectElement>('[aria-label="Routine machine"]')?.value).toBe(
    'local',
  )
  expect(document.querySelector('[aria-label="Routine repository"]')).toBeNull()
  expect(useRoutinesStore.getState().editorDrafts).toEqual({})
})

it('saves the changed repository after closing and reopening an existing remote draft', async () => {
  const nextRepository = { id: 'fedcba9876543210', name: 'Other repo' }
  invoke.mockImplementation(async (channel, target) => {
    if (channel === 'routines:list')
      return target
        ? { ...snapshot, routines: [remote] }
        : {
            ...snapshot,
            machines: [{ ...machine, repositories: [...machine.repositories, nextRepository] }],
          }
    return defaultInvoke(channel, target)
  })
  await act(async () => root.render(<RoutinesPage workspacePath="/local" />))
  await click('Remote taskHost repobee1PausedOpen for run history')
  await click('Edit')
  await choose('Routine repository', nextRepository.id)
  await closeEditor()
  await click('Edit')
  expect(
    document.querySelector<HTMLSelectElement>('[aria-label="Routine repository"]')?.value,
  ).toBe(nextRepository.id)
  const trust = document.querySelector<HTMLInputElement>('input[type=checkbox]')
  await act(async () => trust!.click())
  await click('Enable on bee1')
  expect(invoke).toHaveBeenCalledWith(
    'routines:save',
    expect.objectContaining({
      repositoryId: nextRepository.id,
      workspacePath: nextRepository.name,
      trusted: true,
    }),
    remote.id,
    remote.revision,
    host,
  )
})

it('clears a restored repository no longer offered and requires a fresh choice', async () => {
  await act(async () => root.render(<RoutinesPage workspacePath="/local" />))
  await click('Remote taskHost repobee1PausedOpen for run history')
  await click('Edit')
  await choose('Routine repository', machine.repositories[0]!.id)
  await closeEditor()
  const replacement = { id: 'fedcba9876543210', name: 'Replacement' }
  await act(async () =>
    useRoutinesStore.setState({ machines: [{ ...machine, repositories: [replacement] }] }),
  )
  await click('Edit')
  expect(
    document.querySelector<HTMLSelectElement>('[aria-label="Routine repository"]')?.value,
  ).toBe('')
  expect(saveButton().disabled).toBe(true)
  expect(useRoutinesStore.getState().editorDrafts[remote.id]?.repositoryId).toBe('')
  expect(useRoutinesStore.getState().editorDrafts[remote.id]?.input.workspacePath).toBe('')
  await act(async () => saveButton().click())
  expect(invoke.mock.calls.some(([c]) => c === 'routines:save')).toBe(false)
  await choose('Routine repository', replacement.id)
  expect(saveButton().disabled).toBe(false)
})

it('clears a missing machine on a new draft without falling back to local', async () => {
  await act(async () => root.render(<RoutinesPage workspacePath="/local" />))
  await click('New routine')
  await choose('Routine machine', host)
  await choose('Routine repository', machine.repositories[0]!.id)
  await closeEditor()
  await act(async () => useRoutinesStore.setState({ machines: [] }))
  await click('Resume draft')
  expect(document.querySelector<HTMLSelectElement>('[aria-label="Routine machine"]')?.value).toBe(
    '',
  )
  expect(saveButton().disabled).toBe(true)
  expect(document.querySelector('[aria-label="Workspace"]')).toBeNull()
  expect(useRoutinesStore.getState().editorDrafts.new?.machineId).toBe('')
})

it('keeps an existing routine machine locked while absent and sends nothing', async () => {
  await act(async () => root.render(<RoutinesPage workspacePath="/local" />))
  await click('Remote taskHost repobee1PausedOpen for run history')
  await act(async () => useRoutinesStore.setState({ machines: [] }))
  await click('Edit')
  const select = document.querySelector<HTMLSelectElement>('[aria-label="Routine machine"]')!
  expect(select.disabled).toBe(true)
  expect(select.value).toBe('')
  expect(document.body.textContent).toContain('Machine routines are unavailable.')
  expect(saveButton().disabled).toBe(true)
  await act(async () => saveButton().click())
  expect(invoke.mock.calls.some(([c]) => c === 'routines:save')).toBe(false)
  await act(async () => useRoutinesStore.setState({ machines: [machine] }))
  expect(
    document.querySelector<HTMLSelectElement>('[aria-label="Routine repository"]')?.value,
  ).toBe(machine.repositories[0]!.id)
  expect(saveButton().disabled).toBe(false)
})
