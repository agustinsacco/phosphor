import { expect, it, vi } from 'vitest'

const { handlers, snapshot, never } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  snapshot: { routines: [], runs: [], background: false, error: null },
  never: vi.fn(() => new Promise(() => {})),
}))
vi.mock('./handle', () => ({
  handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
    handlers.set(channel, handler),
}))
vi.mock('../hosts/runtime', () => ({
  remoteRoutineMachines: () => [
    {
      id: 'host:11111111-1111-4111-8111-111111111111',
      label: 'bee1',
      available: true,
      control: true,
      repositories: [{ id: '0123456789abcdef', name: 'repo' }],
    },
  ],
  remoteCall: never,
}))
vi.mock('../routines', () => ({ routinesSnapshot: () => snapshot, routineScheduler: vi.fn() }))
vi.mock('../routines/background', () => ({ configureRoutineBackground: vi.fn() }))
vi.mock('../routines/preflight', () => ({ folderTaskObstacle: vi.fn() }))
vi.mock('../broadcast', () => ({ broadcast: vi.fn() }))
vi.mock('../debug-log', () => ({ log: vi.fn() }))
vi.mock('../pi/delete-lane', () => ({ deleteLane: vi.fn() }))
vi.mock('../pi/health', () => ({ checkPiHealth: vi.fn() }))
vi.mock('../pi/stub', () => ({ piStubPath: vi.fn() }))
import { registerRoutinesHandlers } from './routines-handlers'

it('local routines:list returns synchronously and never waits for a Host', () => {
  registerRoutinesHandlers()
  const result = handlers.get('routines:list')?.({})
  expect(result).not.toBeInstanceOf(Promise)
  expect(result).toMatchObject({ ...snapshot, machines: [{ label: 'bee1' }] })
  expect(never).not.toHaveBeenCalled()
  expect(JSON.stringify(result)).not.toContain('path')
  expect(JSON.stringify(result)).not.toContain('endpoint')
})
