import { RemoteWorkspacePage } from '@/features/home/RemoteWorkspacePage'

/** The compact shell supplies the Host; creation itself is shared with Desktop. */
export function CompactNew({ hostId }: { hostId: string }): React.JSX.Element {
  return <RemoteWorkspacePage hostId={hostId} />
}
