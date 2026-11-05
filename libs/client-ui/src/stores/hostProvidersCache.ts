import type { MachineSettings } from '@shared/machine-settings'
import { machineReadGeneration } from './machineReadGeneration'

export type HostProviders = NonNullable<MachineSettings['providers']>

const TTL_MS = 60_000

const reads = new Map<string, { generation: number; at: number; read: Promise<HostProviders> }>()

/**
 * A Host's providers settings (Claude accounts, cooldowns, routing), read at most
 * once a minute per Host connection. On the Host this read runs `claude auth
 * status` once per account, so a surface that only needs the account count and
 * cooldowns must not pay that on every open. Concurrent readers share one read;
 * a failed read is not kept, so the next caller asks again. The caller holds the
 * configuration grant: this never asks for it.
 */
export function readHostProviders(hostId: string, now = Date.now()): Promise<HostProviders> {
  const generation = machineReadGeneration(hostId)
  const cached = reads.get(hostId)
  if (cached && cached.generation === generation && now - cached.at < TTL_MS) return cached.read
  const read = window.phosphor.invoke('hosts:settingsRead', hostId, 'providers').then((data) => {
    if (!data.providers) throw new Error('The Host sent no provider settings.')
    return data.providers
  })
  const entry = { generation, at: now, read }
  reads.set(hostId, entry)
  read.catch(() => {
    if (reads.get(hostId) === entry) reads.delete(hostId)
  })
  return read
}

/** After a lane moves or an account changes: the next read asks the Host again. */
export function forgetHostProviders(hostId: string): void {
  reads.delete(hostId)
}
