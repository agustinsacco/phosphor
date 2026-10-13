import { TooltipButton } from '@/components/Tooltip'
import { useEffect, useState } from 'react'
import { useChatStore } from '@/stores/chat'
import { piCallOk } from '@/lib/rpc'
import { Spinner } from '@/components/icons'

export function RetryStrip({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const retry = useChatStore((s) => s.sessions[sessionId]?.retry)
  const [remaining, setRemaining] = useState(0)

  useEffect(() => {
    if (!retry) return
    const startedAt = Date.now()
    setRemaining(retry.delayMs)
    const interval = setInterval(() => {
      const left = Math.max(0, retry.delayMs - (Date.now() - startedAt))
      setRemaining(left)
    }, 250)
    return () => clearInterval(interval)
  }, [retry])

  if (!retry) return null

  const cancel = async (): Promise<void> => {
    // A failed cancel leaves the strip counting down with no explanation, so
    // this one really does need the error branch it used to skip.
    await piCallOk(sessionId, { type: 'abort_retry' })
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-1 pb-2">
      <div className="bg-warning/10 border-warning/30 flex items-center gap-2.5 rounded-lg border px-3 py-2 text-base">
        <Spinner className="text-warning" />
        <span className="text-text">
          Retrying ({retry.attempt}/{retry.maxAttempts})
          {remaining > 0 ? ` in ${Math.ceil(remaining / 1000)}s` : '…'}
        </span>
        <span className="text-text-tertiary flex-1 truncate" data-tooltip={retry.errorMessage}>
          {retry.errorMessage}
        </span>
        <TooltipButton
          onClick={() => void cancel()}
          className="text-text-secondary hover:text-danger shrink-0 text-base font-medium transition-colors"
        >
          Cancel
        </TooltipButton>
      </div>
    </div>
  )
}
