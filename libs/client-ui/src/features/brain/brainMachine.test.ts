import { expect, it } from 'vitest'
import type { HostsSnapshot } from '@shared/ipc'
import { brainMachine } from './brainMachine'

it('routes only This Mac to the proved Desktop owner, even if the service offers Brain', () => {
  const hosts = {
    harbor: { state: 'ready', local: true, brain: true },
    ledger: { state: 'ready', brain: true },
  } as unknown as HostsSnapshot
  expect(brainMachine('local', hosts, true)).toBe('local')
  expect(brainMachine('harbor', hosts, true)).toBe('local')
  expect(brainMachine('ledger', hosts, true)).toBe('ledger')
  expect(brainMachine('local', hosts, false)).toBe('harbor')
})
