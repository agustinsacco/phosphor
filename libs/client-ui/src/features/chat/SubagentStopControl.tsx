import { useState } from 'react'
import { Button } from '@/components/form'
import { errorText } from '@shared/errors'
import { stopSubagent } from './subagentStop'
import { useSubagentCommands } from './subagentCommands'

/** The extension owns the stop and its persisted receipt. Never optimistically mark a run stopped. */
export function SubagentStop({
  sessionId,
  runId,
}: {
  sessionId: string
  runId: string
}): React.JSX.Element {
  const { supported, blocked } = useSubagentCommands(sessionId)
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<string>()
  const [error, setError] = useState<string>()
  const stop = async (): Promise<void> => {
    setPending(true)
    setError(undefined)
    try {
      await stopSubagent(sessionId, runId)
      setNotice(
        'Stop requested. The extension records the outcome in the conversation. This is not process-exit proof.',
      )
      setConfirming(false)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setPending(false)
    }
  }
  return (
    <div className="border-border mt-4 border-t pt-3 text-base">
      {error && (
        <p className="text-danger mb-2" role="alert">
          {error}
        </p>
      )}
      {notice ? (
        <p className="text-text-secondary" role="status">
          {notice}
        </p>
      ) : confirming ? (
        <>
          <p className="text-text-secondary mb-2">
            Stop this entire background run? Partial changes remain, and stopped runs cannot resume.
          </p>
          <div className="flex gap-2">
            <Button variant="danger" disabled={pending || !!blocked} onClick={() => void stop()}>
              Stop this run
            </Button>
            <Button disabled={pending} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <Button
          disabled={!!blocked || !supported('subagents-stop')}
          title={
            blocked ??
            (supported('subagents-stop')
              ? undefined
              : 'This session does not advertise the Stop command.')
          }
          onClick={() => setConfirming(true)}
        >
          Stop run…
        </Button>
      )}
    </div>
  )
}
