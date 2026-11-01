import { expect, it, vi } from 'vitest'
import type { CommandResult } from '../requests'
import {
  createMachinePrograms,
  HOST_UPDATE_NOT_STARTED,
  HOST_UPDATE_UNSUPPORTED,
} from './machine-programs'
import type { TerminalConnection } from './terminal-state'

/** A ready Host with configuration access whose command answers with `result`. */
function programs(result: CommandResult) {
  const send = vi.fn(async () => result)
  const connection = {
    snapshot: () => ({
      state: 'ready',
      capabilities: ['terminal', 'sessions.control', 'machine.configure'],
    }),
    incarnation: () => ({ runtimeEpoch: '1111111111111111', generation: 1 }),
    send,
  } as unknown as TerminalConnection
  const bridge = createMachinePrograms({
    connection: () => connection,
    control: () => true,
    entries: new Map(),
    admissions: new Set(),
    flushKill: async () => {},
  })
  return { bridge, send }
}

// An older Host's parser has no `host.update` task, so it rejects the op as malformed.
it.each(['bad-request', 'unsupported'] as const)(
  'tells the person to update an older Host by hand once when it answers %s',
  async (code) => {
    const t = programs({ requestId: 'r', status: 'rejected', code })
    await expect(
      t.bridge.task(1, 'host', { type: 'machine.task', task: 'host.update' }),
    ).rejects.toThrow(HOST_UPDATE_UNSUPPORTED)
    expect(t.send).toHaveBeenCalledWith({ type: 'machine.task', task: 'host.update' })
  },
)

// A current Host refuses where its updater must not run from a button: macOS, a source install.
it('says the update did not start when a current Host refuses it', async () => {
  // The Host's refusal leaves the command unanswered, which it reports as unknown.
  const t = programs({ requestId: 'r', status: 'unknown' })
  await expect(
    t.bridge.task(1, 'host', { type: 'machine.task', task: 'host.update' }),
  ).rejects.toThrow(HOST_UPDATE_NOT_STARTED)
})

it('keeps the fixed message for every other refused program', async () => {
  const t = programs({ requestId: 'r', status: 'rejected', code: 'bad-request' })
  await expect(
    t.bridge.task(1, 'host', { type: 'machine.task', task: 'claude.installProvider' }),
  ).rejects.toThrow('Sign-in not confirmed. Refresh before trying again.')
})
