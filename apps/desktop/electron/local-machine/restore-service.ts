import type { OwnerChannel } from './migration/owner-channel'
import type { RestorePorts } from './restore'

/**
 * The break-glass restore's two service callbacks (M4), over the owner
 * channel the launch gate uses. Each acts only on the service that
 * identifies as the migration's machine.
 */
export interface RestoreServicePorts {
  /** This Mac's service, or null when it does not answer in time. */
  open(): Promise<OwnerChannel | null>
  now(): number
  wait(ms: number): Promise<void>
  log(event: string, data?: Record<string, unknown>): void
}

/** How long the service gets to restart in standby after a release. */
export const STANDBY_WAIT_MS = 60_000
const POLL_MS = 1_000

async function withService(
  ports: RestoreServicePorts,
  machineId: string,
  use: (channel: OwnerChannel) => Promise<boolean>,
): Promise<boolean> {
  const channel = await ports.open()
  if (!channel) return false
  try {
    if (channel.machineId !== machineId) {
      ports.log('restore-wrong-machine')
      return false
    }
    return await use(channel)
  } catch (error) {
    ports.log('restore-service-refused', { error: String(error) })
    return false
  } finally {
    channel.close()
  }
}

export function restoreServicePorts(
  ports: RestoreServicePorts,
): Pick<RestorePorts, 'stopLanes' | 'releaseToStandby'> {
  return {
    // The service refuses a release while any lane runs, so its answer confirms none does.
    stopLanes: (machineId) =>
      withService(ports, machineId, async (channel) => {
        await channel.call('machine.owner', { action: 'release' })
        return true
      }),
    // It answers the release, then restarts in standby without the owner lock.
    async releaseToStandby(machineId) {
      const deadline = ports.now() + STANDBY_WAIT_MS
      for (;;) {
        const free = await withService(ports, machineId, async (channel) => {
          const lock = (await channel.call('machine.local', undefined)).ownerLock
          return !!lock?.standby && !lock.held
        })
        if (free) return true
        if (ports.now() >= deadline) return false
        await ports.wait(POLL_MS)
      }
    },
  }
}
