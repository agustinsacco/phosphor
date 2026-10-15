import { machineStatus } from '@shared/control-api'
import { CheckIcon } from '@/components/icons'
import { BeforeYouStart } from './onboarding/BeforeYouStart'
import { OnlineAndProviders } from './onboarding/OnlineAndProviders'
import { SshInstallPanel } from './SshInstallPanel'
import { useEffect, useRef, useState } from 'react'
import {
  normalizeLabel,
  normalizeUserCode,
  type EnrollmentLookupResponse,
  type MachineView,
} from '@shared/control-api'
import { TooltipSummary } from '@/components/Tooltip'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
import { Button, TextInput } from '@/components/form'
import { machinesAccountGeneration, useMachinesStore } from '@/stores/machines'
import { controlMessage } from './controlMessages'
import { formatCode, platformName } from './machinePresentation'
import { CopyCommand, HostGuide, HostSetup } from './MachineControls'

type Step = 'before' | 'providers' | 'on-machine' | 'code' | 'confirm' | 'finishing' | 'done'
export function AddMachineDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [step, setStep] = useState<Step>('before')
  const [suggestedTarget, setSuggestedTarget] = useState('')
  const [ssh, setSsh] = useState(false)
  const [sshActive, setSshActive] = useState(false)
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
        if (sshFingerprint && (!details || details.keyFingerprint !== sshFingerprint)) {
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
          setStep(sshFingerprint && !sshDone.current ? 'finishing' : 'done')
        } else setError(controlMessage(result.ok ? 'signed-out' : result.error.code))
      }
    } catch {
      if (live.current) setError(controlMessage('offline'))
    } finally {
      pending.current = false
      if (live.current) setBusy(false)
    }
  }
  const directory = useMachinesStore()
  const currentMachine = directory.machines.find((m) => m.id === added?.id) ?? added
  const online =
    currentMachine &&
    machineStatus(currentMachine, directory.nowMs || Date.now(), directory.clockOffsetMs) === 'up'
  const stepIndex = step === 'before' ? 0 : step === 'done' ? 2 : step === 'providers' ? 3 : 1
  const valid = step === 'code' ? !!normalizedCode : !!normalizedLabel
  return (
    <ModalOverlay onClose={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Add a machine" className="max-w-full">
        <ModalPanel
          width={600}
          title="Add a machine"
          footer={
            step === 'done' || step === 'providers' ? (
              <>
                <Button onClick={onClose}>Close</Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    if (step === 'done' && online) {
                      setStep('providers')
                      return
                    }
                    if (added) useMachinesStore.getState().show({ kind: 'machine', id: added.id })
                    onClose()
                  }}
                >
                  {step === 'done' && online ? 'Continue to Providers' : 'View machine'}
                </Button>
              </>
            ) : step === 'finishing' ? (
              <Button onClick={onClose}>Cancel</Button>
            ) : (
              <>
                <Button
                  disabled={busy}
                  onClick={() => {
                    if (step === 'before') onClose()
                    else if (step === 'on-machine') setStep('before')
                    else {
                      setStep(step === 'confirm' ? 'code' : 'on-machine')
                      setError(null)
                    }
                  }}
                >
                  {step === 'before' ? 'Cancel' : 'Back'}
                </Button>
                <Button
                  variant="primary"
                  disabled={busy || (step !== 'before' && step !== 'on-machine' && !valid)}
                  onClick={() => {
                    if (step === 'before') setStep('on-machine')
                    else if (step === 'on-machine') setStep('code')
                    else void submit()
                  }}
                >
                  {busy
                    ? 'Working…'
                    : step === 'before'
                      ? 'Continue to Install'
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
            <ol
              aria-label="Setup steps"
              className="text-text-tertiary flex flex-wrap gap-3 text-sm"
            >
              {['Before you start', 'Install', 'Online', 'Providers'].map((title, index) => (
                <li
                  key={title}
                  aria-current={stepIndex === index ? 'step' : undefined}
                  className={`flex items-center gap-1 ${stepIndex === index ? 'text-accent font-semibold' : stepIndex > index ? 'text-success' : ''}`}
                >
                  {stepIndex > index ? (
                    <span aria-label="Completed">
                      <CheckIcon size={14} />
                    </span>
                  ) : (
                    `${index + 1} ·`
                  )}{' '}
                  {title}
                </li>
              ))}
            </ol>
            {step === 'before' && (
              <BeforeYouStart
                installActive={sshActive}
                onReturnToInstall={() => setStep('on-machine')}
                onPick={(target) => {
                  setSuggestedTarget(target)
                  setSsh(true)
                  setStep('on-machine')
                }}
              />
            )}
            {step === 'on-machine' && (
              <div className="space-y-3">
                <h2 className="text-xl font-semibold">Prepare the other machine</h2>
                <p className="text-text-secondary">
                  Install over SSH from here, or run the terminal commands on the machine you want
                  to add.
                </p>
              </div>
            )}
            {ssh && (
              <div hidden={step === 'before' || step === 'done' || step === 'providers'}>
                <SshInstallPanel
                  initialTarget={suggestedTarget}
                  onState={(event) => {
                    setSshActive(
                      event === null || event.kind === 'progress' || event.kind === 'enrollment',
                    )
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
              </div>
            )}
            {step === 'on-machine' && (
              <>
                {!ssh && <Button onClick={() => setSsh(true)}>Install over SSH</Button>}
                {ssh ? (
                  <details className="space-y-3">
                    <TooltipSummary>Prefer terminal commands?</TooltipSummary>
                    <HostSetup />
                    <HostGuide />
                  </details>
                ) : (
                  <>
                    <HostSetup />
                    <HostGuide />
                  </>
                )}
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
            {step === 'done' && sshDone.current && <p>Host service installed.</p>}
            {(step === 'done' || step === 'providers') && added && (
              <OnlineAndProviders
                added={added}
                providers={step === 'providers'}
                onProviders={() => setStep('providers')}
                onOpen={() => {
                  useMachinesStore.getState().show({ kind: 'machine', id: added.id })
                  onClose()
                }}
              />
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
