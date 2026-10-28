import { Row, SectionTitle } from '@/components/form'
import { InstallApp } from '@/shell/compact/InstallApp'
import { useInstallApp } from '@/shell/compact/useInstallApp'

/** Installing the browser client as an app, and what it still cannot do. */
export function InstallAppTab(): React.JSX.Element {
  const { installed } = useInstallApp()
  return (
    <div>
      <SectionTitle>App installation</SectionTitle>
      <Row
        title="Install"
        description="Opens Phosphor in its own window from your home screen or app launcher. Your browser controls installation."
      >
        {installed ? (
          <span className="text-text-secondary text-base">Installed</span>
        ) : (
          <InstallApp />
        )}
      </Row>
      <h3 className="mb-2 mt-6 text-lg font-semibold">Notifications</h3>
      <p className="text-text-secondary text-base">
        Push notifications are not available yet. Inbox shows attention while the app is connected.
      </p>
    </div>
  )
}
