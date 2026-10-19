import type { GrantClient } from '@phosphor/shared/host-grant'
import type { HostCapability } from '@phosphor/shared/remote-host'

/** A lost configuration grant cannot be restored for already admitted work. */
export function createConfigurationAuthority(ports: {
  caps(): readonly HostCapability[]
  closed(): boolean
  open(): boolean
}) {
  let epoch = 0
  return {
    renew(next: readonly HostCapability[]): boolean {
      const lost = ports.caps().includes('machine.configure') && !next.includes('machine.configure')
      if (lost) epoch++
      return lost
    },
    sender(client: GrantClient, connectionId: string) {
      const admittedEpoch = epoch
      return {
        id: client.id,
        label: client.label,
        caps: ports.caps(),
        currentCaps: () =>
          ports.closed()
            ? []
            : epoch !== admittedEpoch
              ? ports.caps().filter((cap) => cap !== 'machine.configure')
              : ports.caps(),
        connectionId,
      }
    },
    admit(capability: HostCapability | null): () => boolean {
      const admittedEpoch = epoch
      return () =>
        !ports.closed() &&
        ports.open() &&
        (capability !== 'machine.configure' || admittedEpoch === epoch) &&
        (capability === null || ports.caps().includes(capability))
    },
  }
}
