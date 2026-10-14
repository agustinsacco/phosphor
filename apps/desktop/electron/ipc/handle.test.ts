import { expect, it, vi } from 'vitest'
const main = vi.hoisted(() => ({ handle: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: main }))
import { handle, rejectRemoteArguments, setRemoteReadRouter } from './handle'

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

it('routes reads before local side effects and retains the refusal for writes', async () => {
  const local = vi.fn()
  const call = vi.fn(async () => ['a.ts'])
  setRemoteReadRouter((windowId, channel, args) => {
    if (channel !== 'fs:listFiles' || !String(args[0]).startsWith('host:')) return null
    expect(windowId).toBe(7)
    return { result: call() }
  })
  try {
    handle('fs:listFiles', local)
    const read: unknown = main.handle.mock.calls.at(-1)?.[1]
    if (typeof read !== 'function') throw new Error('Missing handler')
    expect(await read({ sender: { id: 7 } }, 'host:machine/repository')).toEqual(['a.ts'])
    expect(local).not.toHaveBeenCalled()
    handle('fs:writeFile', local)
    const write: unknown = main.handle.mock.calls.at(-1)?.[1]
    if (typeof write !== 'function') throw new Error('Missing handler')
    expect(() => write({ sender: { id: 7 } }, 'host:machine/repository/a.ts', 'write')).toThrow(
      'Not available on remote lanes yet.',
    )
    expect(local).not.toHaveBeenCalled()
  } finally {
    setRemoteReadRouter(() => null)
  }
})
