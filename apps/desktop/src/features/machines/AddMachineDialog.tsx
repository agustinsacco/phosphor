import { SshInstallPanel } from './SshInstallPanel'
import { useEffect, useRef, useState } from 'react'
import {
  normalizeLabel,
  normalizeUserCode,
  type EnrollmentLookupResponse,
  type MachineView,
} from '@shared/control-api'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
import { Button, TextInput } from '@/components/form'
import { machinesAccountGeneration, useMachinesStore } from '@/stores/machines'
import { controlMessage } from './controlMessages'
import { HOST_RUN, HOST_SERVICE_INSTALL, formatCode, platformName } from './machinePresentation'
import { CopyCommand, HostGuide, HostSetup } from './MachineControls'

type Step = 'on-machine' | 'code' | 'confirm' | 'finishing' | 'done'
export function AddMachineDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [step, setStep] = useState<Step>('on-machine')
  const [ssh, setSsh] = useState(false)
  const [sshFingerprint, setSshFingerprint] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [details, setDetails] = useState<EnrollmentLookupResponse | null>(null)
  const [added, setAdded] = useState<MachineView | null>(null)
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sshDone = useRef(false)
  const pending = useRef(false)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const normalizedCode = normalizeUserCode(code)
  const normalizedLabel = normalizeLabel(label)
  async function submit(
    enrollmentCode = normalizedCode,
    fingerprint = sshFingerprint,
    lookupOnly = false,
  ): Promise<void> {
    if (
      pending.current ||
      !enrollmentCode ||
      (!lookupOnly && step === 'confirm' && !normalizedLabel)
    )
      return
    pending.current = true
    const generation = machinesAccountGeneration()
    setBusy(true)
    setError(null)
    try {
      if (step === 'code' || lookupOnly) {
        const result = await window.phosphor.invoke('control:lookupEnrollment', enrollmentCode)
        if (!live.current) return
        if (generation !== machinesAccountGeneration()) {
          setError(controlMessage('signed-out'))
          return
        }
        if (result.ok && fingerprint && result.keyFingerprint !== fingerprint) {
          setError(
            'The fingerprints do not match. Cancel installation. Do not approve this machine.',
          )
          return
        }
        if (result.ok && useMachinesStore.getState().remoteEnabled) {
          setDetails(result)
          setLabel(result.hostname)
          setStep('confirm')
        } else setError(controlMessage(result.ok ? 'signed-out' : result.error.code))
      } else if (step === 'confirm' && normalizedLabel) {
        if (ssh && (!details || details.keyFingerprint !== sshFingerprint)) {
          setError('The fingerprints do not match. Do not approve this machine.')
          return
        }
        const result = await window.phosphor.invoke(
          'control:approveEnrollment',
          enrollmentCode,
          normalizedLabel,
        )
        // The store outlives this dialog: a machine approved after closing still appears.
        if (result.ok && generation === machinesAccountGeneration())
          void useMachinesStore.getState().refresh()
        if (!live.current) return
        if (generation !== machinesAccountGeneration()) {
          setError(controlMessage('signed-out'))
          return
        }
        if (result.ok && useMachinesStore.getState().remoteEnabled) {
          setAdded(result.machine)
          setStep(ssh && !sshDone.current ? 'finishing' : 'done')
        } else setError(controlMessage(result.ok ? 'signed-out' : result.error.code))
      }
    } catch {
      if (live.current) setError(controlMessage('offline'))
    } finally {
      pending.current = false
      if (live.current) setBusy(false)
    }
  }
  const valid = step === 'code' ? !!normalizedCode : !!normalizedLabel
  return (
    <ModalOverlay onClose={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Add a machine" className="max-w-full">
        <ModalPanel
          width={600}
          title="Add a machine"
          footer={
            step === 'done' ? (
              <>
                <Button onClick={onClose}>Close</Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    if (added) useMachinesStore.getState().show({ kind: 'machine', id: added.id })
                    onClose()
                  }}
                >
                  View machine
                </Button>
              </>
            ) : step === 'finishing' ? (
              <Button onClick={onClose}>Cancel</Button>
            ) : (
              <>
                <Button
                  disabled={busy}
                  onClick={() => {
                    if (step === 'on-machine') onClose()
                    else {
                      setStep(step === 'confirm' ? 'code' : 'on-machine')
                      setError(null)
                    }
                  }}
                >
                  {step === 'on-machine' ? 'Cancel' : 'Back'}
                </Button>
                <Button
                  variant="primary"
                  disabled={busy || (step !== 'on-machine' && !valid)}
                  onClick={() => {
                    if (step === 'on-machine') setStep('code')
                    else void submit()
                  }}
                >
                  {busy
                    ? 'Working…'
                    : step === 'on-machine'
                      ? 'I have a code'
                      : step === 'code'
                        ? 'Look up code'
                        : 'Approve machine'}
                </Button>
              </>
            )
          }
        >
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
            className="max-h-[65vh] space-y-4 overflow-y-auto px-6 py-5 text-base"
          >
            <p className="text-text-tertiary font-mono text-xs uppercase tracking-wider">
              {step === 'on-machine'
                ? '1 · On the machine'
                : step === 'code'
                  ? '2 · Enter the code'
                  : step === 'confirm'
                    ? '3 · Confirm'
                    : step === 'finishing'
                      ? '4 · Finishing install'
                      : '4 · Done'}
            </p>
            {ssh && (
              <SshInstallPanel
                onState={(event) => {
                  sshDone.current = event?.kind === 'done' && event.step === 'service'
                  if (sshDone.current)
                    setStep((current) => (current === 'finishing' ? 'done' : current))
                }}
                onEnrollment={(value, fingerprint) => {
                  setCode(value)
                  setSshFingerprint(fingerprint)
                  setStep('code')
                  setDetails(null)
                  void submit(value, fingerprint, true)
                }}
              />
            )}
            {step === 'on-machine' && (
              <>
                <h2 className="text-xl font-semibold">Prepare the other machine</h2>
                <p className="text-text-secondary">
                  Run these commands on the machine you want to add, not on this computer.
                </p>
                <Button onClick={() => setSsh(true)}>Install over SSH</Button>
                <HostSetup />
                <HostGuide />
              </>
            )}
            {step === 'code' && (
              <>
                <h2 className="text-xl font-semibold">Enter the code from the Host</h2>
                <p className="text-text-secondary">
                  Use the code printed by phosphor login. Codes expire after 10 minutes.
                </p>
                <label className="block">
                  Code
                  <TextInput
                    autoFocus
                    className="mt-2 w-full font-mono"
                    value={code}
                    maxLength={32}
                    placeholder="BCDF-GHJK"
                    onChange={(e) => setCode(formatCode(e.target.value))}
                  />
                </label>
                {code && !normalizedCode && (
                  <p className="text-text-secondary">Enter the eight letters from the Host.</p>
                )}
              </>
            )}
            {step === 'confirm' && details && (
              <>
                <h2 className="text-xl font-semibold">Is this your machine?</h2>
                <div className="border-border bg-bg-secondary space-y-1 rounded-lg border p-4">
                  <p className="text-lg font-medium">{details.hostname}</p>
                  <p className="text-text-secondary">
                    {platformName(details.platform)} {details.arch} · Host {details.hostVersion}
                  </p>
                </div>
                <p className="text-text-secondary">
                  Compare this fingerprint with what phosphor login printed. Only approve a machine
                  you recognise.
                </p>
                {sshFingerprint && (
                  <>
                    <p>Enrollment code: {formatCode(code)}</p>
                    <p>Host fingerprint: {sshFingerprint}</p>
                  </>
                )}
                <CopyCommand command={details.keyFingerprint} />
                <label className="block">
                  Machine label
                  <TextInput
                    autoFocus
                    className="mt-2 w-full"
                    value={label}
                    maxLength={80}
                    onChange={(e) => setLabel(e.target.value)}
                  />
                </label>
                {label && !normalizedLabel && (
                  <p role="alert" className="text-danger">
                    Use 1 to 80 characters without hidden control characters.
                  </p>
                )}
              </>
            )}
            {step === 'finishing' && added && (
              <h2 className="text-xl font-semibold">Finishing install on {added.label}...</h2>
            )}
            {step === 'done' && added && (
              <>
                <h2 className="text-xl font-semibold">{added.label} added</h2>
                <p className="text-text-secondary">
                  Start the Host on {added.label} to bring it online.
                </p>
                <CopyCommand command={HOST_RUN} />
                <p className="text-text-secondary">
                  On Linux, keep it online after logout and reboot:
                </p>
                <CopyCommand command={HOST_SERVICE_INSTALL} />
              </>
            )}
            {error && (
              <p role="alert" className="text-danger bg-danger-soft rounded-md p-3">
                {error}
              </p>
            )}
          </form>
        </ModalPanel>
      </div>
    </ModalOverlay>
  )
}
