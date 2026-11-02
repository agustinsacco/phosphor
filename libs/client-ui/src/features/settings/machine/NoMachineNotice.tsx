import { SettingsNotice } from '@/components/form'
import { useNavigation } from '@/navigation/Navigation'

/** Why no machine sections are listed: this client knows no machine it can configure yet. */
export function NoMachineNotice(): React.JSX.Element {
  const { navigate } = useNavigation()
  return (
    <div className="px-2 pt-2 text-sm" data-testid="settings-no-machine">
      <SettingsNotice
        tone="info"
        title="No machine to configure"
        body="Machine settings appear here once a Host is added and connected."
        action={{
          label: 'Open Machines',
          onClick: () => navigate({ to: 'page', page: 'machines' }),
        }}
      />
    </div>
  )
}
