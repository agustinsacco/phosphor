import type { LocalMachineStatus } from '@shared/ipc'
import { handle } from './handle'

/** This Mac before any move to the Phosphor service: Desktop runs its lanes itself. */
export const IN_APP_LOCAL_MACHINE: LocalMachineStatus = { mode: 'in-app', migration: 'not-needed' }

/** This Mac's runtime card: status and the buttons on it. */
export function registerLocalMachineHandlers(): void {
  handle('app:localMachine', () => IN_APP_LOCAL_MACHINE)
  handle('app:localMachineAction', () => ({
    ok: false,
    message: 'This Mac runs its lanes in Phosphor itself; there is nothing to do yet.',
  }))
}
