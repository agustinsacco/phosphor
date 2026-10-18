import { expect, it } from 'vitest'
import { captureCompletionFence } from './completion-fence'
import type { HostsSnapshot, IpcInvokeChannel } from '@phosphor/shared/ipc'

function fixture() {
  const hosts: HostsSnapshot = Object.fromEntries(
    ['a', 'b'].map((id) => [
      id,
      { state: 'ready', connectionToken: id, capabilities: [], repositories: [], lanes: [] },
    ]),
  )
  const sessions = [
    {
      sessionId: 'remote-fixture',
      workspacePath: 'host:a/lane:fixture',
      target: { kind: 'remote' as const, hostId: 'a' },
    },
  ]
  return {
    hosts,
    fence: (channel: IpcInvokeChannel, args: unknown[]) =>
      captureCompletionFence(channel, args, () => hosts, sessions),
  }
}
it.each([
  ['routines:run', ['host:a/run', 'request']],
  ['routines:save', [{}, undefined, undefined, 'host:a']],
  ['routines:save', [{}, 'host:a/routine', 1]],
  ['artifacts:read', ['host:a/lane:fixture/artifact:fixture']],
  ['artifacts:forSession', ['remote-fixture']],
  ['pi:command', ['remote-fixture', { type: 'get_state' }]],
  ['hosts:createLane', ['a', {}]],
  ['fs:readFile', ['host:a/lane:fixture/file']],
] as [IpcInvokeChannel, unknown[]][])(
  'scopes %s completion to its actual Host',
  (channel, args) => {
    const s = fixture(),
      current = s.fence(channel, args)
    s.hosts.b!.connectionToken = 'reconnected'
    expect(current()).toBe(true)
    s.hosts.a!.connectionToken = 'reconnected'
    expect(current()).toBe(false)
  },
)
it.each(['artifacts:list', 'routines:list'] as const)(
  'retains all directory dependencies for aggregate %s reads',
  (channel) => {
    const s = fixture(),
      current = s.fence(channel, [])
    s.hosts.b!.connectionToken = 'reconnected'
    expect(current()).toBe(false)
  },
)
