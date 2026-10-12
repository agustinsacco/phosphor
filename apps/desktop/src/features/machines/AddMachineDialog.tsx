import { useEffect, useRef, useState } from 'react'
import {
  normalizeLabel,
  normalizeUserCode,
  type EnrollmentLookupResponse,
} from '@shared/control-api'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
import { Button, TextInput } from '@/components/form'
import { useMachinesStore } from '@/stores/machines'
import { controlMessage } from './controlMessages'

export function AddMachineDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [code, setCode] = useState('')
  const [details, setDetails] = useState<EnrollmentLookupResponse | null>(null)
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const normalizedCode = normalizeUserCode(code)
  const normalizedLabel = normalizeLabel(label)
  async function submit(): Promise<void> {
    if (busy || !normalizedCode || (details && !normalizedLabel)) return
    setBusy(true)
    setError(null)
    try {
      if (!details) {
        const result = await window.phosphor.invoke('control:lookupEnrollment', normalizedCode)
        if (!live.current) return
        if (result.ok) {
          setDetails(result)
          setLabel(result.hostname)
        } else setError(controlMessage(result.error.code))
      } else if (normalizedLabel) {
        const result = await window.phosphor.invoke(
          'control:approveEnrollment',
          normalizedCode,
          normalizedLabel,
        )
        if (result.ok) {
          void useMachinesStore.getState().refresh()
          if (live.current) onClose()
        } else if (live.current) setError(controlMessage(result.error.code))
      }
    } catch {
      if (live.current) setError(controlMessage('offline'))
    } finally {
      if (live.current) setBusy(false)
    }
  }
  return (
    <ModalOverlay onClose={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Add a machine">
        <ModalPanel
          width={480}
          title="Add a machine"
          footer={
            <>
              <Button onClick={onClose}>Cancel</Button>
              <Button
                variant="primary"
                disabled={busy || !normalizedCode || (!!details && !normalizedLabel)}
                onClick={() => void submit()}
              >
                {busy ? 'Working…' : details ? 'Approve' : 'Look up code'}
              </Button>
            </>
          }
        >
          <div className="space-y-3 p-4 text-base">
            {details ? (
              <>
                <p>
                  {details.hostname} · {details.platform}/{details.arch} · Host{' '}
                  {details.hostVersion}
                </p>
                <p className="break-all font-mono">{details.keyFingerprint}</p>
                <p>Check that the machine printed the same fingerprint.</p>
                <label className="block">
                  Label
                  <TextInput
                    className="mt-1 w-full"
                    value={label}
                    maxLength={80}
                    onChange={(e) => setLabel(e.target.value)}
                  />
                </label>
                {label && !normalizedLabel && (
                  <p role="alert" className="text-danger">
                    {label.trim().length < 1 || label.trim().length > 80
                      ? 'Use a label with 1 to 80 characters.'
                      : 'The label has characters that cannot be shown.'}
                  </p>
                )}
                <Button
                  size="xs"
                  disabled={busy}
                  onClick={() => {
                    setDetails(null)
                    setError(null)
                  }}
                >
                  Use another code
                </Button>
              </>
            ) : (
              <>
                <p>
                  On the machine, run <code>phosphor login</code>, then enter the code it prints.
                </p>
                <label className="block">
                  Code
                  <TextInput
                    autoFocus
                    className="mt-1 w-full font-mono"
                    value={code}
                    maxLength={32}
                    placeholder="BCDF-GHJK"
                    onChange={(e) => setCode(e.target.value)}
                  />
                </label>
              </>
            )}
            {error && (
              <p role="alert" className="text-danger">
                {error}
              </p>
            )}
          </div>
        </ModalPanel>
      </div>
    </ModalOverlay>
  )
}
