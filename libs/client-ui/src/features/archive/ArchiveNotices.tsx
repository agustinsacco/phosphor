import { usePlatform } from '@/platform/Platform'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useArchiveInventory } from '@/stores/archives'

export function ArchiveNotices(): React.JSX.Element {
  const { localLanes } = usePlatform()
  const hosts = useRemoteLanesStore((state) => state.hosts)
  return (
    <>
      {localLanes && <Notice machine="local" />}
      {Object.entries(hosts)
        .filter(
          ([, host]) =>
            host.state === 'ready' &&
            host.laneArchive &&
            host.capabilities.includes('sessions.read'),
        )
        .map(([id]) => (
          <Notice key={id} machine={id} />
        ))}
    </>
  )
}
function Notice({ machine }: { machine: string }): null {
  useArchiveInventory(machine, true)
  return null
}
