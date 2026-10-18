import { useEffect, useState } from 'react'
import { useChatStore } from '@/stores/chat'
import { PhosphorLoader } from '@/components/PhosphorLoader'
import { BOOT_PHRASE_MS, bootPhrase } from './bootPhrases'

/**
 * True between "prompt sent" and pi's first word.
 *
 * Shared with the sidebar so a booting session's row pulses like a streaming
 * one: the row and the chat must never disagree about whether a lane is doing
 * something.
 */
export function useSessionBooting(sessionId: string | undefined): boolean {
  return useChatStore((s) => {
    const session = sessionId ? s.sessions[sessionId] : undefined
    if (!session) return false
    return session.promptSentAt != null && !session.isStreaming && !session.error
  })
}

/** Rotates the phrase every BOOT_PHRASE_MS while mounted. */
function usePhrase(sessionId: string): string {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), BOOT_PHRASE_MS)
    return () => clearInterval(interval)
  }, [])
  return bootPhrase(sessionId, tick)
}

/**
 * "pi is starting" strip, in the same slot the `WorkingIndicator` uses.
 *
 * Handing a prompt to pi can be silent for many seconds — the provider CLI is
 * spawning, the session is resuming, the model has not produced a first token.
 * Nothing rendered during that window, so a brand-new lane looked frozen: no
 * timer, no spinner, just the user's own bubble. This fills it, and hands over
 * to the working indicator the moment `agent_start` lands.
 */
export function BootingIndicator({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const booting = useSessionBooting(sessionId)
  const phrase = usePhrase(sessionId)
  if (!booting) return null

  return (
    <div className="mx-auto w-full max-w-3xl px-1 pb-2" data-testid="booting-indicator">
      <div className="text-text-secondary flex items-center gap-2 px-2 text-base">
        <PhosphorLoader decorative />
        {/* Re-keyed so a new phrase fades in rather than swapping mid-word. */}
        <span key={phrase} className="name-enter truncate">
          {phrase}
        </span>
      </div>
    </div>
  )
}
