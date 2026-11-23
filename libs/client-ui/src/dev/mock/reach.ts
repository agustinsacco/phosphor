import type { IpcInvokeMap } from '@shared/ipc'

/** Harness machine reach: the switch is not served yet, as in Desktop. */
export const REACH_MOCK: ReadonlySet<string> = new Set<keyof IpcInvokeMap>([
  'control:setMachineReach',
])

export function mockReachInvoke(): Promise<IpcInvokeMap['control:setMachineReach']['result']> {
  return Promise.resolve({
    ok: false,
    error: { code: 'unavailable', message: 'Machine reach is not available yet.' },
  })
}
