import { useMachinePagesStore } from '@/stores/machinePages'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { newRoutine, type Routine, type RoutinesSnapshot, type RoutineRun } from '@shared/routines'
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
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  useRemoteLanesStore.setState({ filter: 'local' })
  useMachinePagesStore.setState({ routinesMachine: 'all' })
  useRemoteLanesStore.setState({
    hosts: {
      [host.slice(5)]: {
        state: 'ready',
        connectionToken: 'test',
        capabilities: ['routines'],
        repositories: [],
        lanes: [],
      },
    },
  })
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
  await click('All machines')
  await click('bee1')
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

it('resumes the Host slot after its target machine disappears and reappears', async () => {
  await act(async () => root.render(<RoutinesPage workspacePath="/local" />))
  await act(async () => useMachinePagesStore.setState({ routinesMachine: host }))
  await click('New routine')
  await choose('Routine machine', host)
  await choose('Routine repository', machine.repositories[0]!.id)
  await closeEditor()
  await act(async () => {
    useMachinePagesStore.setState({ routinesMachine: host })
    useRoutinesStore.setState({ machines: [] })
  })
  await click('Resume draft')
  expect(document.querySelector<HTMLSelectElement>('[aria-label="Routine machine"]')?.value).toBe(
    '',
  )
  expect(saveButton().disabled).toBe(true)
  expect(document.querySelector('[aria-label="Workspace"]')).toBeNull()
  expect(useRoutinesStore.getState().editorDrafts[`new/${host}`]?.machineId).toBe('')
  await closeEditor()
  await act(async () => useRoutinesStore.setState({ machines: [machine] }))
  expect(container.textContent).toContain('Resume draft')
  expect(
    Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'New routine'),
  ).toBe(false)
  await click('Resume draft')
  expect(document.querySelector<HTMLSelectElement>('[aria-label="Routine machine"]')?.value).toBe(
    '',
  )
  expect(saveButton().disabled).toBe(true)
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

it.each([
  ['local', host.slice(5), 'local'],
  [host.slice(5), 'local', host.slice(5)],
])('page follows switcher and drops stale detail on %j', async (...sequence) => {
  useMachinePagesStore.setState({ routinesMachine: '' })
  for (const id of sequence) {
    await act(async () => {
      useRemoteLanesStore.getState().setFilter(id)
      root.render(<RoutinesPage workspacePath="/local" />)
    })
    const remoteTarget = id !== 'local'
    expect(container.textContent).toContain(remoteTarget ? 'Remote task' : 'Local task')
    expect(container.textContent).not.toContain(remoteTarget ? 'Local task' : 'Remote task')
    expect(
      [...container.querySelectorAll('button')].some((button) => button.textContent === 'Edit'),
    ).toBe(false)
    const row = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes(remoteTarget ? 'Remote task' : 'Local task'),
    )!
    await act(async () => row.click())
    expect(
      [...container.querySelectorAll('button')].some((button) => button.textContent === 'Edit'),
    ).toBe(true)
  }
  await act(async () => useRemoteLanesStore.setState({ hosts: {} }))
  if (sequence.at(-1) !== 'local') {
    expect(container.textContent).toContain('Not available on remote lanes yet.')
    expect(container.textContent).not.toContain('Local task')
    expect(container.textContent).not.toContain('Remote task')
  }
})

it('remote history does not offer a local lane action without a remote lane identity', async () => {
  invoke.mockImplementation(async (channel, machineArg) =>
    channel === 'routines:history'
      ? [
          {
            id: `${host}/run`,
            routineId: remote.id,
            trigger: 'manual',
            scheduledAt: Date.now(),
            createdAt: Date.now(),
            startedAt: Date.now(),
            endedAt: Date.now(),
            status: 'finished',
            reason: 'Done',
            definition: remote,
            sessionId: null,
            sessionPath: null,
            workspacePath: null,
            branch: null,
            baseCommit: null,
            accountId: null,
            summary: 'Remote result',
          },
        ]
      : defaultInvoke(channel, machineArg),
  )
  await act(async () => root.render(<RoutinesPage workspacePath="/local" />))
  await click('Remote taskHost repobee1PausedOpen for run history')
  expect(container.textContent).toContain('Output not available from this machine yet')
  expect(
    [...container.querySelectorAll('button')].some(
      (b) => b.textContent === 'Continue lane' || b.textContent === 'Open running lane',
    ),
  ).toBe(false)
})

const localRun: RoutineRun = {
  id: 'local-run',
  routineId: local.id,
  trigger: 'manual',
  scheduledAt: 1,
  createdAt: 1,
  startedAt: 1,
  endedAt: null,
  status: 'running',
  reason: '',
  definition: local,
  sessionId: null,
  sessionPath: null,
  workspacePath: '/local',
  branch: null,
  baseCommit: null,
  accountId: null,
  summary: 'Local run summary',
}

async function renderHostWithLocalActivity(empty = false) {
  invoke.mockImplementation(async (channel, target) => {
    if (channel === 'routines:list')
      return target
        ? { ...snapshot, routines: empty ? [] : [remote] }
        : {
            ...snapshot,
            routines: [local, { ...local, id: 'archived', archived: true }],
            runs: [localRun],
          }
    return defaultInvoke(channel, target)
  })
  await act(async () => root.render(<RoutinesPage workspacePath="/local" />))
  // Match the sidebar switch while a stale page override exists.
  await act(async () => useRemoteLanesStore.getState().setFilter(host.slice(5)))
  expect(useMachinePagesStore.getState().routinesMachine).toBe('')
}

it('hides This Mac activity and routines on an empty Host selected in the sidebar', async () => {
  await renderHostWithLocalActivity(true)
  expect(container.textContent).not.toContain('Local task')
  expect(container.textContent).not.toContain('Local run summary')
  expect(container.textContent).not.toContain('Activity')
  expect(container.textContent).toContain('Save a task. Give it a schedule.')
  expect(container.querySelectorAll('[data-testid=routine-row]')).toHaveLength(0)
})

it('counts only non-archived routines on the selected machine', async () => {
  await renderHostWithLocalActivity()
  expect(
    container.querySelector('[data-testid=global-page]')?.textContent ?? container.textContent,
  ).toMatch(/^Routines1/)
})

it('shows Host execution guidance without This Mac background controls', async () => {
  await renderHostWithLocalActivity()
  expect(container.querySelector('footer')?.textContent).toContain('Desktop can be closed.')
  expect(container.querySelector('footer')?.textContent).not.toContain('this computer')
  expect(container.querySelector('footer input')).toBeNull()
})

it('labels aggregate activity as This Mac and retains local background controls', async () => {
  await renderHostWithLocalActivity()
  await act(async () => useMachinePagesStore.setState({ routinesMachine: 'all' }))
  expect(container.textContent).toContain('This Mac activity')
  expect(container.querySelector('footer input')).not.toBeNull()
})

it('clears local detail and its running state after a sidebar switch to a Host', async () => {
  await renderHostWithLocalActivity()
  await act(async () => useRemoteLanesStore.getState().setFilter('local'))
  const row = container.querySelector<HTMLButtonElement>('[data-testid=routine-row]')
  await act(async () => row?.click())
  expect(container.textContent).toContain('Local task')
  await act(async () => useRemoteLanesStore.getState().setFilter(host.slice(5)))
  expect(container.textContent).not.toContain('Local task')
  expect(container.textContent).not.toContain('Cancel run')
  expect(container.textContent).toContain('Remote task')
})

it('shows local load failures only on This Mac and labels them under All machines', async () => {
  await renderHostWithLocalActivity()
  await act(async () => useRoutinesStore.setState({ error: 'Local failure' }))
  expect(container.textContent).not.toContain('Local failure')
  await act(async () => useMachinePagesStore.setState({ routinesMachine: 'local' }))
  expect(container.textContent).toContain('Local failure')
  await act(async () => useMachinePagesStore.setState({ routinesMachine: 'all' }))
  expect(container.textContent).toContain('This Mac: Local failure')
})

it('drops an action error from This Mac when the selection moves to a Host', async () => {
  await renderHostWithLocalActivity()
  await act(async () => useRemoteLanesStore.getState().setFilter('local'))
  const fallback = invoke.getMockImplementation()!
  invoke.mockImplementation(async (channel, target) => {
    if (channel === 'routines:pauseAll') throw new Error('Local pause failed')
    return fallback(channel, target)
  })
  await click('Pause all')
  expect(container.textContent).toContain('Local pause failed')
  await act(async () => useRemoteLanesStore.getState().setFilter(host.slice(5)))
  expect(container.textContent).not.toContain('Local pause failed')
})

it('keeps new routine drafts separate per machine and resumes only the selected machine', async () => {
  await renderHostWithLocalActivity(true)
  await act(async () =>
    useRoutinesStore.setState({
      editorDrafts: {
        new: {
          input: { ...local, name: 'Local unsaved' },
          revision: null,
          machineId: 'local',
          repositoryId: '',
        },
      },
    }),
  )
  expect(container.textContent).not.toContain('Resume draft')
  await click('New routine')
  expect(document.querySelector<HTMLSelectElement>('[aria-label="Routine machine"]')?.value).toBe(
    host,
  )
  expect(
    document.querySelector<HTMLInputElement>('[role=dialog] input[maxlength="100"]')?.value,
  ).not.toBe('Local unsaved')
  await choose('Routine repository', machine.repositories[0]!.id)
  await closeEditor()
  expect(useRoutinesStore.getState().editorDrafts.new?.input.name).toBe('Local unsaved')
  expect(useRoutinesStore.getState().editorDrafts[`new/${host}`]?.machineId).toBe(host)
  await click('Resume draft')
  await click('Reset')
  await closeEditor()
  expect(useRoutinesStore.getState().editorDrafts.new?.input.name).toBe('Local unsaved')
  await act(async () => useRemoteLanesStore.getState().setFilter('local'))
  await click('Resume draft')
  expect(document.querySelector<HTMLSelectElement>('[aria-label="Routine machine"]')?.value).toBe(
    'local',
  )
  expect(
    document.querySelector<HTMLInputElement>('[role=dialog] input[maxlength="100"]')?.value,
  ).toBe('Local unsaved')
  expect(useRoutinesStore.getState().editorDrafts.new?.input.name).toBe('Local unsaved')
})

it('keeps the opening slot when a resumed Mac draft targets a Host with its own draft', async () => {
  await renderHostWithLocalActivity(true)
  await act(async () => {
    useRoutinesStore.setState({
      editorDrafts: {
        new: {
          input: { ...local, name: 'Mac original text' },
          revision: null,
          machineId: 'local',
          repositoryId: '',
        },
        [`new/${host}`]: {
          input: { ...remote, name: 'Host original text' },
          revision: null,
          machineId: host,
          repositoryId: machine.repositories[0]!.id,
        },
      },
    })
    useRemoteLanesStore.getState().setFilter('local')
  })
  await click('Resume draft')
  await choose('Routine machine', host)
  await choose('Routine repository', machine.repositories[0]!.id)
  await closeEditor()
  expect(useRoutinesStore.getState().editorDrafts.new?.machineId).toBe(host)
  expect(useRoutinesStore.getState().editorDrafts.new?.input.name).toBe('Mac original text')
  await act(async () => useRemoteLanesStore.getState().setFilter(host.slice(5)))
  await click('Resume draft')
  expect(
    document.querySelector<HTMLInputElement>('[role=dialog] input[maxlength="100"]')?.value,
  ).toBe('Host original text')
  await closeEditor()
  await act(async () => useRemoteLanesStore.getState().setFilter('local'))
  await click('Resume draft')
  expect(
    document.querySelector<HTMLInputElement>('[role=dialog] input[maxlength="100"]')?.value,
  ).toBe('Mac original text')
  expect(document.querySelector<HTMLSelectElement>('[aria-label="Routine machine"]')?.value).toBe(
    host,
  )
})

it('deduplicates aggregate and per-Host routine rows by id, preferring the refreshed Host row', async () => {
  invoke.mockImplementation(async (channel, target) =>
    channel === 'routines:list'
      ? target
        ? { ...snapshot, routines: [remote] }
        : { ...snapshot, routines: [{ ...remote, name: 'Stale aggregate name' }] }
      : defaultInvoke(channel, target),
  )
  await act(async () => root.render(<RoutinesPage workspacePath="" />))
  expect(container.querySelectorAll('[data-testid="routine-row"]')).toHaveLength(1)
  expect(container.textContent).toContain('Remote task')
  expect(container.textContent).not.toContain('Stale aggregate name')
})
