import { useEffect, useRef, useState } from 'react'
import type { SshInstallEvent } from '@shared/ssh-install'
import { validSshRepository, validSshTarget } from '@shared/ssh-install'
import { TooltipSummary } from '@/components/Tooltip'
import { Button, TextInput } from '@/components/form'

export function SshInstallPanel({
  onEnrollment,
  onState,
}: {
  onEnrollment: (code: string, fingerprint: string) => void
  onState: (event: SshInstallEvent | null) => void
}): React.JSX.Element {
  const [target, setTarget] = useState('')
  const [repository, setRepository] = useState('')
  const [state, setState] = useState<SshInstallEvent | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const job = useRef<string | null>(null)
  const off = useRef<(() => void) | null>(null)
  const live = useRef(true)
  const pending = useRef(false)
  const repositoryInput = useRef<HTMLInputElement>(null)
  const enrollment = useRef(onEnrollment)
  enrollment.current = onEnrollment
  const reportState = useRef(onState)
  reportState.current = onState
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
      off.current?.()
      if (job.current) void window.phosphor.invoke('hosts:sshInstallCancel', job.current)
    }
  }, [])
  useEffect(() => {
    if (state?.kind === 'failed' && state.step === 'setup' && !busy)
      repositoryInput.current?.focus()
  }, [state, busy])
  async function start() {
    if (pending.current || !validSshTarget(target) || !validSshRepository(repository)) return
    pending.current = true
    setBusy(true)
    setError('')
    setState(null)
    reportState.current(null)
    try {
      const result = await window.phosphor.invoke('hosts:sshInstall', target, repository)
      if (!live.current) {
        void window.phosphor.invoke('hosts:sshInstallCancel', result.jobId)
        return
      }
      job.current = result.jobId
      off.current?.()
      off.current = window.phosphor.onSshInstall(result.jobId, (event) => {
        setState(event)
        reportState.current(event)
        if (event.kind === 'enrollment') enrollment.current(event.code, event.fingerprint)
        if (event.kind === 'failed' || event.kind === 'done' || event.kind === 'cancelled') {
          job.current = null
          pending.current = false
          setBusy(false)
        }
      })
    } catch {
      pending.current = false
      if (live.current) {
        setBusy(false)
        setError(
          'Could not start SSH installation. Check the target or an existing install, then try again.',
        )
      }
    }
  }
  return (
    <section className="space-y-3" aria-label="Install over SSH">
      <p>SSH uses your keys, agent, config and known_hosts. No passwords are requested.</p>
      <label className="block">
        SSH target
        <TextInput
          value={target}
          maxLength={318}
          disabled={busy}
          placeholder="user@host or alias"
          onChange={(e) => setTarget(e.target.value)}
        />
      </label>
      <label className="block">
        Repository on that machine (relative to home)
        <TextInput
          ref={repositoryInput}
          value={repository}
          maxLength={200}
          disabled={busy}
          placeholder="src/project (optional)"
          onChange={(e) => setRepository(e.target.value)}
        />
      </label>
      <Button
        disabled={busy || !validSshTarget(target) || !validSshRepository(repository)}
        onClick={() => void start()}
      >
        {state?.kind === 'failed' || error ? 'Try again' : 'Install Host'}
      </Button>
      {busy && (
        <Button
          onClick={() => {
            if (job.current) void window.phosphor.invoke('hosts:sshInstallCancel', job.current)
          }}
        >
          Cancel install
        </Button>
      )}
      <p role="status">
        {state?.kind === 'progress'
          ? `Host ${state.step} is running.`
          : state?.kind === 'enrollment'
            ? 'Waiting for approval below.'
            : state?.kind === 'done'
              ? 'Host service installed.'
              : state?.kind === 'cancelled'
                ? 'Installation cancelled.'
                : ''}
      </p>
      {state?.kind === 'failed' && (
        <>
          <p role="alert">{state.message}</p>
          <details>
            <TooltipSummary>Remote output (last 20 lines)</TooltipSummary>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap">
              {state.output.join('\n')}
            </pre>
          </details>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
