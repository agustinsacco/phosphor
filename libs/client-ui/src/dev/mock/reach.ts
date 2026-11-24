import type { IpcInvokeMap } from '@shared/ipc'
import type { MachineView } from '@shared/control-api'

export const REACH_MOCK: ReadonlySet<string> = new Set<keyof IpcInvokeMap>([
  'control:setMachineReach',
])

const reachKey = (id: string): string => `mock:machine-reach:${id}`
export const mockReachFlags = (id: string) => ({
  machineGrants: true,
  machineReach: localStorage.getItem(reachKey(id)) !== 'off',
})

export async function mockReachInvoke(
  args: readonly unknown[],
  signedIn: boolean,
  machines: () => MachineView[],
): Promise<IpcInvokeMap['control:setMachineReach']['result']> {
  if (!signedIn)
    return { ok: false, error: { code: 'signed-out', message: 'Sign in to Phosphor.' } }
  const [id, enabled] = args
  if (typeof id !== 'string' || typeof enabled !== 'boolean')
    return { ok: false, error: { code: 'bad-request', message: 'Invalid reach setting.' } }
  if (!machines().some((machine) => machine.id === id))
    return { ok: false, error: { code: 'not-found', message: 'Machine not found.' } }
  localStorage.setItem(reachKey(id), enabled ? 'on' : 'off')
  return { ok: true, machineReach: enabled }
}
