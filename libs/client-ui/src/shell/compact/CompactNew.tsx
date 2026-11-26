import { RemoteWorkspacePage } from '@/features/home/RemoteWorkspacePage'
import { MachinePicker } from '@/features/machines/MachinePicker'
import { useNavigation } from '@/navigation/Navigation'
import { LaneCreateView } from '@/features/sessions/LaneCreateView'
import { useLaneCreatesStore } from '@/stores/laneCreates'

/**
 * The browser supplies the Host and a picker to change it; creation itself is
 * shared with Desktop. `create` is a New lane placeholder's route: the same
 * view Desktop shows, until its lane takes over (or the composer, once gone).
 */
export function CompactNew({
  hostId,
  create,
}: {
  hostId: string
  create?: string
}): React.JSX.Element {
  const { navigate } = useNavigation()
  const placeholder = useLaneCreatesStore((s) => (create ? s.creates[create] : undefined))
  if (create && placeholder?.hostId === hostId && !placeholder.retired)
    return (
      <div className="relative h-full">
        <LaneCreateView id={create} />
      </div>
    )
  return (
    <RemoteWorkspacePage
      hostId={hostId}
      machinePicker={
        <MachinePicker
          value={hostId}
          capability="sessions.control"
          onChange={(machine) => navigate({ to: 'new', machine })}
        />
      }
    />
  )
}
