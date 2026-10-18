import { ModalOverlay, ModalPanel } from '@/components/Modal'
import { MachineFilesPane } from '@/features/files/MachineFilesPane'
import { useState } from 'react'
import { Button } from '@/components/form'
import { useNavigation } from '@/navigation/Navigation'
import { useSettingsStore } from '@/stores/settings'
import { SCREENS } from '@/navigation/screens'

export function CompactSettings({ machine }: { machine?: string }): React.JSX.Element {
  const { navigate } = useNavigation()
  const theme = useSettingsStore((s) => s.theme)
  const [files, setFiles] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <section className="compact-list" aria-label="Settings">
      <h1>More</h1>
      {(['routines', 'skills', 'artifacts'] as const).map((page) => (
        <Button key={page} onClick={() => navigate({ to: 'page', page, machine })}>
          {SCREENS[page].title}
        </Button>
      ))}
      {machine && <Button onClick={() => setFiles(true)}>Machine files</Button>}
      {files && machine && (
        <ModalOverlay onClose={() => setFiles(false)}>
          <ModalPanel
            width={640}
            title="Machine files"
            footer={<Button onClick={() => setFiles(false)}>Close</Button>}
          >
            <div className="h-[65dvh]">
              <MachineFilesPane hostId={machine} />
            </div>
          </ModalPanel>
        </ModalOverlay>
      )}
      <h2>Appearance</h2>
      <div role="group" aria-label="Theme" className="flex gap-2">
        {(['light', 'dark', 'system'] as const).map((value) => (
          <Button
            key={value}
            aria-pressed={theme === value}
            onClick={() => useSettingsStore.getState().setTheme(value)}
          >
            {value}
          </Button>
        ))}
      </div>
      <h2>Notifications</h2>
      <p>
        Push notifications are not available yet. Inbox shows attention while the app is connected.
      </p>
      <h2>This browser</h2>
      <p>
        Terminal, file and image editing, local lanes and native settings are available in Desktop,
        not here.
      </p>
      <Button
        disabled={busy}
        onClick={() => {
          setBusy(true)
          setError('')
          void window.phosphor
            .invoke('account:signOut')
            .catch(() => setError('Could not sign out. Try again.'))
            .finally(() => setBusy(false))
        }}
      >
        {busy ? 'Signing out…' : 'Sign out'}
      </Button>
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
