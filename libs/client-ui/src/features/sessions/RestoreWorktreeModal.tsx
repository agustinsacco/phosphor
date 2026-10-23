import { useEffect, useState } from 'react'
import type { WorktreeRecovery } from '@shared/models'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
import { Button } from '@/components/form'
import { restoreCheckout, useRestoreWorktree, type RestoreTarget } from './completionActions'
import {
  editedFilesNote,
  recoveryOptions,
  type RecoveryOption,
  type RecoverySource,
} from './worktreeRecovery'

/** Loads again when the target or the retry counter changes; a failed first load recovers. */
function useRecovery(target: RestoreTarget | null, attempt: number) {
  const [recovery, setRecovery] = useState<WorktreeRecovery | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setRecovery(null)
    setLoadError(null)
    if (target) {
      window.phosphor.invoke('sessions:worktreeRecovery', target.meta.cwd).then(
        (result) => {
          if (!cancelled) setRecovery(result)
        },
        (reason: unknown) => {
          if (!cancelled) setLoadError(String(reason))
        },
      )
    }
    return () => {
      cancelled = true
    }
  }, [target, attempt])
  return { recovery, loadError }
}

/**
 * Brings back a removed checkout in its original folder. Main decides what is
 * possible; this only lets the user pick, most exact option first.
 */
export function RestoreWorktreeModal(): React.JSX.Element | null {
  const target = useRestoreWorktree((s) => s.target)
  const [attempt, setAttempt] = useState(0)
  const { recovery, loadError } = useRecovery(target, attempt)
  const [picked, setPicked] = useState<RecoverySource | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!target) return null
  const options = recovery ? recoveryOptions(recovery) : []
  const choice = options.find((o) => o.value === picked)?.value ?? options[0]?.value
  const close = (): void => {
    if (busy) return
    setPicked(null)
    setError(null)
    useRestoreWorktree.setState({ target: null })
  }
  const submit = async (): Promise<void> => {
    if (!choice) return
    setBusy(true)
    setError(null)
    try {
      await restoreCheckout(target, choice)
      setPicked(null)
      useRestoreWorktree.setState({ target: null })
    } catch (reason) {
      setError(String(reason))
    } finally {
      setBusy(false)
    }
  }
  return (
    <ModalOverlay onClose={close}>
      <div role="dialog" aria-modal="true" aria-label="Restore worktree">
        <ModalPanel
          width={560}
          title="Restore worktree"
          subtitle="Recreates the checkout in its original folder. The conversation is not changed. Dependencies must be reinstalled."
          footer={
            <>
              <Button onClick={close} disabled={busy}>
                Cancel
              </Button>
              {choice && (
                <Button variant="primary" disabled={busy} onClick={() => void submit()}>
                  {busy ? 'Restoring…' : target.resume ? 'Restore and continue' : 'Restore'}
                </Button>
              )}
            </>
          }
        >
          <div className="space-y-3 px-4 py-3">
            {loadError ? (
              <div role="alert" className="space-y-2">
                <p className="break-words">{loadError}</p>
                <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
              </div>
            ) : !recovery ? (
              <p role="status">Checking what can be restored…</p>
            ) : options.length === 0 ? (
              <p>{recovery.unavailable ?? 'This checkout cannot be recreated.'}</p>
            ) : (
              <>
                <RecoveryChoices options={options} choice={choice} busy={busy} onPick={setPicked} />
                <p className="text-text-secondary text-sm">{editedFilesNote(recovery)}</p>
              </>
            )}
            {error && (
              <p role="alert" className="break-words">
                {error}
              </p>
            )}
          </div>
        </ModalPanel>
      </div>
    </ModalOverlay>
  )
}

function RecoveryChoices(props: {
  options: RecoveryOption[]
  choice: RecoverySource | undefined
  busy: boolean
  onPick: (value: RecoverySource) => void
}): React.JSX.Element {
  return (
    <fieldset className="space-y-2">
      <legend className="sr-only">Restore from</legend>
      {props.options.map((option) => (
        <label
          key={option.value}
          className="border-border flex cursor-pointer gap-3 rounded-lg border px-3 py-2"
        >
          <input
            type="radio"
            name="restore-source"
            value={option.value}
            checked={props.choice === option.value}
            disabled={props.busy}
            onChange={() => props.onPick(option.value)}
          />
          <span className="min-w-0">
            <span className="block break-words">{option.label}</span>
            <span className="text-text-tertiary block text-sm break-words">{option.detail}</span>
          </span>
        </label>
      ))}
    </fieldset>
  )
}
