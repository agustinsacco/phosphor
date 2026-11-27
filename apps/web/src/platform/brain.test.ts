import { expect, it, vi } from 'vitest'
import type { PhosphorApi } from '@phosphor/shared/ipc'
import type { BrainAccess } from '@phosphor/shared/brain-access'
import type { HostCapability } from '@phosphor/shared/remote-host'
import { createBrowserBrain } from './brain'

function connection(connectionToken: string) {
  const snapshot = {
    state: 'ready' as const,
    capabilities: ['sessions.control'] as HostCapability[],
    repositories: [],
    lanes: [],
    brain: true,
    connectionToken,
    // Brain Agent's conversation takes every Brain right and lane control.
    brainAccess: ['read', 'control', 'evidence', 'configure'] as BrainAccess[],
  }
  return { view: snapshot, snapshot: () => snapshot }
}

it('pins writes and drops late reads on replacement, sign-out and loss of access', async () => {
  const harbor = connection('harbor-1')
  const ledger = connection('ledger-1')
  const hosts = new Map([
    ['harbor', harbor],
    ['ledger', ledger],
  ])
  let owner = 1
  let finish: (value: null) => void = () => {}
  const harborCall = vi.fn(
    () =>
      new Promise<null>((resolve) => {
        finish = resolve
      }),
  )
  const ledgerCall = vi.fn().mockResolvedValue(null)
  const brain = createBrowserBrain({
    connection: (id) => hosts.get(id),
    owner: () => owner,
    client: {
      invoke: ((target, _request) =>
        target.hostId === 'harbor' ? harborCall() : ledgerCall()) as NonNullable<
        PhosphorApi['hostBrain']
      >['invoke'],
      listApprovals: async () => [],
      answerApproval: async () => {},
    },
    grants: { setBrainAccess: vi.fn(), grantFor: vi.fn() },
    reconnect: vi.fn(),
  })
  const target = { hostId: 'harbor', connectionToken: 'harbor-1' }
  // Both Hosts see the same controller fence number and message shape.
  const send = { method: 'brain:laneSend', args: ['Harbor', 1] } as const
  const request = { method: send.method, args: [...send.args] as ['Harbor', 1] }
  const pending = brain.invoke<'brain:laneSend'>(target, request)
  hosts.set('harbor', connection('harbor-2'))
  finish(null)
  await expect(pending).rejects.toThrow('unavailable')
  await expect(brain.invoke<'brain:laneSend'>(target, request)).rejects.toThrow('unavailable')
  expect(harborCall).toHaveBeenCalledTimes(1)
  expect(ledgerCall).not.toHaveBeenCalled()

  hosts.set('harbor', harbor)
  const revoked = brain.invoke<'brain:laneShow'>(target, { method: 'brain:laneShow', args: [] })
  harbor.view.brainAccess = ['read']
  finish(null)
  await expect(revoked).rejects.toThrow('unavailable')
  harbor.view.brainAccess = ['read', 'control', 'evidence', 'configure']
  // Losing lane control alone drops the conversation too.
  const uncontrolled = brain.invoke<'brain:laneShow'>(target, {
    method: 'brain:laneShow',
    args: [],
  })
  harbor.view.capabilities = []
  finish(null)
  await expect(uncontrolled).rejects.toThrow('unavailable')
  harbor.view.capabilities = ['sessions.control']
  const signedOut = brain.invoke<'brain:laneShow'>(target, { method: 'brain:laneShow', args: [] })
  owner++
  finish(null)
  await expect(signedOut).rejects.toThrow('unavailable')
  expect(ledgerCall).not.toHaveBeenCalled()
})
