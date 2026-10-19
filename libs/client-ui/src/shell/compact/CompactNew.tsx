import { RemoteStartView } from '@/features/home/RemoteStartView'

/** The compact shell supplies the Host; creation itself is shared with Desktop. */
export function CompactNew({ hostId }: { hostId: string }): React.JSX.Element {
  return <RemoteStartView hostId={hostId} />
}
