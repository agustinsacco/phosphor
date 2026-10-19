import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/form'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
import { installInstructions, useInstallApp } from './useInstallApp'

/** No automatic dialog, storage, account access or promise of background execution. */
export function InstallApp(): React.JSX.Element | null {
  const { installed, available, busy, install } = useInstallApp()
  const [help, setHelp] = useState(false)
  const [message, setMessage] = useState('')
  if (installed) return null
  return (
    <div className="browser-install">
      <Button
        disabled={busy}
        onClick={() => {
          setMessage('')
          if (!available) {
            setHelp(true)
            return
          }
          void install()
            .then((outcome) => {
              if (outcome === 'accepted')
                setMessage('Finish installation in your browser, then launch the new app icon.')
              if (outcome === 'dismissed')
                setMessage('Not installed. You can try again from your browser menu.')
              if (outcome === 'unavailable' || outcome === 'failed') setHelp(true)
            })
            .catch(() => setHelp(true))
        }}
      >
        {busy ? 'Opening installer…' : 'Install Phosphor'}
      </Button>
      {message && (
        <p role="status" className="text-text-secondary mt-2 text-sm">
          {message}
        </p>
      )}
      {help && <InstallHelp onClose={() => setHelp(false)} />}
    </div>
  )
}

function InstallHelp({ onClose }: { onClose: () => void }): React.JSX.Element {
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previous = document.activeElement
    close.current?.focus()
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  return (
    <ModalOverlay onClose={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Install Phosphor"
        onKeyDown={(event) => {
          if (event.key === 'Tab') {
            event.preventDefault()
            close.current?.focus()
          }
        }}
      >
        <ModalPanel
          width={400}
          title="Install Phosphor"
          footer={
            <Button ref={close} onClick={onClose}>
              Close
            </Button>
          }
        >
          <div className="space-y-3 px-4 py-3 text-base">
            <p>Launch Phosphor in its own window from your home screen or app launcher.</p>
            <ol className="list-decimal space-y-2 pl-5">
              {installInstructions(navigator.userAgent).map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <p className="text-text-secondary">
              Installation is controlled by your browser. An automatic prompt is not guaranteed.
            </p>
            <p className="text-text-secondary">
              You still need a private connection to your Host. Installation does not add background
              push or native Desktop tools.
            </p>
            {/iPhone|iPad|iPod/i.test(navigator.userAgent) && (
              <p className="text-text-secondary">
                On iPhone, you may need to sign in again from the new icon.
              </p>
            )}
          </div>
        </ModalPanel>
      </div>
    </ModalOverlay>
  )
}
