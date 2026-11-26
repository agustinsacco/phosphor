import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { promptChoice } from '@/stores/prompt'
import { runHostTask } from './machineProgramActions'

vi.mock('@/stores/prompt', () => ({ promptChoice: vi.fn() }))
const invoke = vi.fn(async () => ({ ptyId: 'pty' }))
const machine = { id: 'host-1', label: 'bee1' }
beforeEach(() => {
  vi.stubGlobal('window', { phosphor: { invoke } })
  vi.mocked(promptChoice).mockReset()
  invoke.mockClear()
})
afterEach(() => vi.unstubAllGlobals())

it('never opens HostProgramDialog for an update task', async () => {
  const openProgram = vi.fn()
  await runHostTask(machine, { current: true }, openProgram, { task: 'host.update' })
  expect(openProgram).not.toHaveBeenCalled()
  expect(promptChoice).not.toHaveBeenCalled()
})

it('still opens the private program for another reviewed task', async () => {
  vi.mocked(promptChoice).mockResolvedValue('run')
  const openProgram = vi.fn(async (start: () => Promise<{ ptyId: string }>) => start())
  await runHostTask(machine, { current: true }, openProgram, { task: 'mcp.login', name: 'demo' })
  expect(invoke).toHaveBeenCalledWith('hosts:machineTask', 'host-1', {
    type: 'machine.task',
    task: 'mcp.login',
    name: 'demo',
  })
})
