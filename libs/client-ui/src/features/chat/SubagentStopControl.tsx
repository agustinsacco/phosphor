import { useState } from 'react'
import { Button } from '@/components/form'
import { useChatStore } from '@/stores/chat'
import { errorText } from '@shared/errors'
import { stopSubagent } from './subagentStop'

/** The extension owns the stop and its persisted receipt. Never optimistically mark a run stopped. */
export function SubagentStop({
  sessionId,
  runId,
}: {
  sessionId: string
  runId: string
}): React.JSX.Element {
  const supported = useChatStore((s) =>
    s.sessions[sessionId]?.commands.some(
      (c) => c.name === 'subagents-stop' && c.source === 'extension',
    ),
  )
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
            <Button variant="danger" disabled={pending} onClick={() => void stop()}>
              Stop this run
            </Button>
            <Button disabled={pending} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <Button
          disabled={!supported}
          title={supported ? undefined : 'This session does not advertise the Stop command.'}
          onClick={() => setConfirming(true)}
        >
          Stop run…
        </Button>
      )}
    </div>
  )
}
