import type { IpcInvokeMap } from '@shared/ipc'

type Channel = 'app:localMachine' | 'app:localMachineAction'

/** Harness This Mac: Desktop runs its own lanes and has nothing to move. */
export const LOCAL_MACHINE_MOCK: ReadonlySet<string> = new Set<Channel>([
  'app:localMachine',
  'app:localMachineAction',
])

export function mockLocalMachineInvoke(channel: string): Promise<IpcInvokeMap[Channel]['result']> {
  return Promise.resolve(
    channel === 'app:localMachine'
      ? { mode: 'in-app', migration: 'not-needed', brainOwner: 'desktop' }
      : {
          ok: false,
          message: 'This Mac runs its lanes in Phosphor itself; there is nothing to do yet.',
        },
  )
}
