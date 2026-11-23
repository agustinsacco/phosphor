import { expect, it, vi } from 'vitest'
import { routineHandlers } from './routines'
import type { DaemonHandlerDeps } from './index'
const definition = {
  name: 'A',
  instructions: 'report',
  repositoryId: '1111111111111111',
  isolated: true,
  intent: 'report',
  provider: 'p',
  model: 'm',
  timezone: 'UTC',
  schedule: { kind: 'manual' },
  period: 'none',
  catchUpHours: 0,
  maxRuntimeMinutes: 5,
}
const id = '11111111-1111-4111-8111-111111111111'
function fixture(trusted: boolean) {
  const execute = vi.fn(async (_op: unknown) => ({ routineId: id, revision: 2 }))
  const row = {
    ...definition,
    id,
    revision: 1,
    enabled: trusted,
    trusted,
    archived: false,
    nextAt: null,
    createdAt: 1,
    updatedAt: 1,
  }
  const handlers = routineHandlers({
    routines: { execute },
    lanes: { calls: { call: async () => ({ ok: true, data: [row] }) } },
  } as unknown as DaemonHandlerDeps)
  return {
    execute,
    run: (name: string, args: unknown) =>
      handlers[name]!(args, {
        principal: { kind: 'local', clientId: 'test' },
        signal: new AbortController().signal,
        log: () => {},
      }),
  }
}
it('creates only a paused untrusted definition', async () => {
  const f = fixture(false)
  await f.run('routine.create', { definition })
  expect(f.execute.mock.calls[0]?.[0]).toMatchObject({
    type: 'routine.save',
    routine: { trusted: false, enabled: false },
  })
})
it.each([
  ['instructions', 'changed', false],
  ['name', 'rename', true],
])('computes trust after editing %s', async (key, value, trusted) => {
  const f = fixture(true)
  await f.run('routine.edit', { id, revision: 1, patch: { [String(key)]: value } })
  expect(f.execute.mock.calls[0]?.[0]).toMatchObject({
    expectedRevision: 1,
    routine: { [String(key)]: value, trusted, enabled: trusted },
  })
})
it.each(['routine.enable', 'routine.run'])(
  'refuses %s without the owner acknowledgement',
  async (name) => {
    const f = fixture(false)
    await expect(f.run(name, { id })).rejects.toThrow(
      'Open Routines and acknowledge unattended access first.',
    )
    expect(f.execute).not.toHaveBeenCalled()
  },
)

it('refuses a stale revision and stores no previous routine content for Undo', async () => {
  const f = fixture(true)
  await expect(f.run('routine.edit', { id, revision: 0, patch: { name: 'old' } })).rejects.toThrow(
    'changed',
  )
  expect(f.execute).not.toHaveBeenCalled()
  const edited = await f.run('routine.edit', { id, revision: 1, patch: { name: 'new' } })
  expect(edited.before).toBeUndefined()
  expect(edited.text).toContain('No Undo:')
})
