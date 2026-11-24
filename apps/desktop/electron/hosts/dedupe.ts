import type { MachinesResponse } from '@phosphor/shared/control-api'
import type { ControlResult } from '@phosphor/shared/ipc'
import { randomUUID } from 'node:crypto'
import type { HostConnectionSnapshot } from '@phosphor/host-client/connection'

/** undefined: awaiting the owner; null: no alias (also the in-app default). */
export type DirectoryAlias = string | null | undefined

export class DirectoryDedupe {
  private alias: DirectoryAlias = null
  get() {
    return this.alias
  }
  set(id: DirectoryAlias) {
    if (id === this.alias) return false
    this.alias = id
    return true
  }
  visible<T extends MachinesResponse>(list: T): T {
    const alias = this.alias
    return alias && list.machines.some((m) => m.id === alias)
      ? { ...list, machines: list.machines.filter((m) => m.id !== alias) }
      : list
  }
}

/** Main's manager and the renderer directory share one identity decision. */
export const desktopDirectory = new DirectoryDedupe()
export function visibleMachines(result: ControlResult<MachinesResponse>) {
  return result.ok ? desktopDirectory.visible(result) : result
}

export function waitingForLocal(previous?: HostConnectionSnapshot): HostConnectionSnapshot {
  return {
    state: 'connecting',
    lastError: 'waiting-local-service',
    connectionToken: previous?.connectionToken ?? randomUUID(),
    repositories: [],
    lanes: [],
    capabilities: [],
  }
}
