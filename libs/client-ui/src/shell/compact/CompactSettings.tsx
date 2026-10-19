import { useState } from 'react'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
import { PageShell } from '@/components/PageShell'
import { PageBody } from '@/components/PageBody'
import { Button } from '@/components/form'
import { MachineFilesPane } from '@/features/files/MachineFilesPane'
import { AppearancePreferences } from '@/features/settings/AppearancePreferences'
import { useNavigation } from '@/navigation/Navigation'
import { SCREENS } from '@/navigation/screens'

/** Browser preferences reuse the native preference rows, never the native settings modal. */
export function CompactSettings({ machine }: { machine?: string }): React.JSX.Element {
  const { navigate } = useNavigation()
  return (
    <PageShell title="Settings">
      <PageBody>
        <div className="space-y-6 text-sm">
          <nav aria-label="More pages" className="flex flex-wrap gap-2">
            {(['routines', 'skills', 'artifacts'] as const).map((page) => (
              <Button key={page} onClick={() => navigate({ to: 'page', page, machine })}>
                {SCREENS[page].title}
              </Button>
            ))}
            {machine && <MachineFilesSettings machine={machine} />}
          </nav>
          <section aria-labelledby="browser-appearance">
            <h2 id="browser-appearance" className="font-semibold">
              Appearance
            </h2>
            <p className="text-text-secondary mt-1">
              Saved in this browser, not synced to other devices.
            </p>
            <AppearancePreferences />
          </section>
          <section aria-labelledby="browser-notifications">
            <h2 id="browser-notifications" className="mb-2 font-semibold">
              Notifications
            </h2>
            <p className="text-text-secondary">
              Push notifications are not available yet. Inbox shows attention while the app is
              connected.
            </p>
          </section>
          <BrowserAccountSettings />
        </div>
      </PageBody>
    </PageShell>
  )
}

function MachineFilesSettings({ machine }: { machine: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>Machine files</Button>
      {open && (
        <ModalOverlay onClose={() => setOpen(false)}>
          <ModalPanel
            width={640}
            title="Machine files"
            footer={<Button onClick={() => setOpen(false)}>Close</Button>}
          >
            <div className="h-[65dvh]">
              <MachineFilesPane hostId={machine} />
            </div>
          </ModalPanel>
        </ModalOverlay>
      )}
    </>
  )
}

function BrowserAccountSettings(): React.JSX.Element {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <section aria-labelledby="browser-account">
      <h2 id="browser-account" className="mb-2 font-semibold">
        This browser
      </h2>
      <p className="text-text-secondary mb-3">
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
