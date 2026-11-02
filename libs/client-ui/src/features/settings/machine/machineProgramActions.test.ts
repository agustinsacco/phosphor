import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { promptChoice } from '@/stores/prompt'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import type { HostLaneView } from '@shared/ipc'
import { runHostTask } from './machineProgramActions'

vi.mock('@/stores/prompt', () => ({ promptChoice: vi.fn() }))
const invoke = vi.fn(async () => ({ ptyId: 'pty' }))
const machine = { id: 'host-1', label: 'bee1' }
const lane = (activity: HostLaneView['activity']) => ({ activity }) as HostLaneView
let initial: ReturnType<typeof useRemoteLanesStore.getState>
beforeEach(() => {
  initial = useRemoteLanesStore.getState()
  vi.stubGlobal('window', { phosphor: { invoke } })
  vi.mocked(promptChoice).mockReset()
  invoke.mockClear()
})
afterEach(() => {
  useRemoteLanesStore.setState(initial, true)
  vi.unstubAllGlobals()
})
function hostLanes(lanes: HostLaneView[]) {
  useRemoteLanesStore.setState({
    hosts: {
      [machine.id]: { lanes } as unknown as ReturnType<
        typeof useRemoteLanesStore.getState
      >['hosts'][string],
    },
  })
}

it('says which lanes the update pauses and starts it only once confirmed', async () => {
  hostLanes([lane('working'), lane('idle'), lane('needs-input')])
  vi.mocked(promptChoice).mockResolvedValue('run')
  const openProgram = vi.fn(
    async (start: () => Promise<{ ptyId: string }>, _title: string, _note?: string) => {
      await start()
    },
  )
  await runHostTask(machine, { current: true }, openProgram, { task: 'host.update' })
  const ask = vi.mocked(promptChoice).mock.calls[0]![0]
  expect(ask.title).toBe('Pause and update bee1?')
  expect(ask.message).toContain('2 lanes on bee1 are working')
  expect(ask.message).not.toContain('Running lanes are not restarted')
  expect(ask.choices).toEqual([{ value: 'run', label: 'Pause and update', primary: true }])
  expect(openProgram.mock.calls[0]![1]).toBe('Host update')
  expect(invoke).toHaveBeenCalledWith('hosts:machineTask', 'host-1', {
    type: 'machine.task',
    task: 'host.update',
  })
})

it('names no paused turn when nothing is working, and sends nothing when declined', async () => {
  hostLanes([lane('idle')])
  vi.mocked(promptChoice).mockResolvedValue(undefined)
  const openProgram = vi.fn()
  await runHostTask(machine, { current: true }, openProgram, { task: 'host.update' })
  expect(vi.mocked(promptChoice).mock.calls[0]![0].message).toContain('No lane on bee1 is working')
  expect(openProgram).not.toHaveBeenCalled()
  expect(invoke).not.toHaveBeenCalled()
})
