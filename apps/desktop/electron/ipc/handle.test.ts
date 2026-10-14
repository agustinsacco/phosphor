import { expect, it, vi } from 'vitest'
const main = vi.hoisted(() => ({ handle: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: main }))
import { handle, rejectRemoteArguments } from './handle'

it('rejects opaque workspaces and remote handles before any local handler runs', () => {
  const local = vi.fn()
  handle('fs:readFile', local)
  const wrapped: unknown = main.handle.mock.calls[0]?.[1]
  if (typeof wrapped !== 'function') throw new Error('Missing handler')
  expect(() => wrapped({}, 'host:machine/repository')).toThrow('Not available on remote lanes yet.')
  expect(local).not.toHaveBeenCalled()
  expect(() => rejectRemoteArguments('sessions:delete', ['remote-0123456789abcdef'])).toThrow()
  expect(() =>
    rejectRemoteArguments('pi:createSession', [{ workspacePath: 'host:machine/repository' }]),
  ).toThrow()
  wrapped({}, '/local/file')
  expect(local).toHaveBeenCalledOnce()
})
it('allows app channels and explicitly routed pi calls, but bounds nested traversal', () => {
  expect(() => rejectRemoteArguments('hosts:openLane', ['remote-0123456789abcdef'])).not.toThrow()
  expect(() => rejectRemoteArguments('pi:command', ['remote-0123456789abcdef'])).not.toThrow()
  expect(() =>
    rejectRemoteArguments(
      'fs:readFile',
      Array.from({ length: 4096 }, () => 'local'),
    ),
  ).toThrow()
  expect(() =>
    rejectRemoteArguments(
      'fs:readFile',
      Array.from({ length: 4095 }, () => 'local'),
    ),
  ).not.toThrow()
  let nested: unknown = 'local'
  for (let i = 0; i < 17; i++) nested = [nested]
  expect(() => rejectRemoteArguments('fs:readFile', [nested])).toThrow()
})
