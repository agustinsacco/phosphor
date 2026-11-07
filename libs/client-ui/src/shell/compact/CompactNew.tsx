import { RemoteWorkspacePage } from '@/features/home/RemoteWorkspacePage'
import { MachinePicker } from '@/features/machines/MachinePicker'
import { useNavigation } from '@/navigation/Navigation'

/** The browser supplies the Host and a picker to change it; creation itself is shared with Desktop. */
export function CompactNew({ hostId }: { hostId: string }): React.JSX.Element {
  const { navigate } = useNavigation()
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
