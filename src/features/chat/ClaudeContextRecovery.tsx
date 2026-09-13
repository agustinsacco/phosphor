import { useState } from 'react'
import { Button } from '@/components/form'
import { useAsyncAction } from '@/components/useAsyncAction'
import { useSessionsStore } from '@/stores/sessions'

/**
 * Recovery for a Claude session the provider refuses to resume.
 *
 * `pi-claude-cli` keeps one Claude Code CLI session per pi session and stores
 * the system prompt it was created with. On every resume it checks that
 * prompt's context policy against the one Phosphor spawns with, and refuses a
 * mismatch rather than splice two sets of instructions into one transcript.
 * The check runs before the model does, so the session answers every message
 * with the same error and there is no way out from inside it — which is why
 * this is a button and not a docs link.
 *
 * The fix is bookkeeping, not surgery: pi holds the whole conversation and the
 * CLI transcript is derived from it, so dropping the pairing makes the next
 * turn a first turn that replays pi's history into a fresh CLI session.
 *
 * It has one real cost and the panel says so plainly, because it is the kind
 * of cost that is invisible until the bill: that first turn re-sends the
 * entire conversation as a cache WRITE instead of reading the cached prefix.
 * Everything after it caches normally again.
 */
export function ClaudeContextRecovery({ sessionId }: { sessionId: string }): React.JSX.Element {
  const sessionFile = useSessionsStore((s) => s.live[sessionId]?.diskPath)
  const [done, setDone] = useState(false)
  const { busy, error, run } = useAsyncAction()

  const rebuild = (): void => {
    if (!sessionFile) return
    void run(async () => {
      await window.phosphor.invoke('sessions:resetClaudeContext', sessionFile)
      setDone(true)
    })
  }

  return (
    <div className="border-danger/20 mt-2 rounded-md border px-2.5 py-2">
      <p className="text-text-secondary text-base leading-relaxed">
        Your conversation is safe — pi keeps the full history. Rebuilding unpairs the Claude
        transcript that can no longer be resumed and re-imports everything into a fresh one.
      </p>
      <p className="text-text-tertiary mt-1.5 text-base leading-relaxed">
        It costs one expensive turn. Claude bills a cache write at 1.25× input where a cache read is
        0.1×, so your next message re-sends the whole conversation as a write — tens of thousands of
        tokens on a long session, once. Every turn after it is cached again.
      </p>

      {done ? (
        <p className="text-success mt-2 text-base">
          Rebuilt — send your message again to continue this session.
        </p>
      ) : (
        <div className="mt-2 flex items-center gap-2.5">
          <Button variant="primary" size="xs" onClick={rebuild} disabled={busy || !sessionFile}>
            {busy ? 'Rebuilding…' : 'Rebuild the Claude session'}
          </Button>
          {/* The session file arrives asynchronously from `get_state`, so say
              why the button is dead instead of showing a dud. */}
          {!sessionFile && (
            <span className="text-text-tertiary text-base">Waiting for the session file…</span>
          )}
        </div>
      )}

      {error && <p className="text-danger mt-1.5 text-base">Could not rebuild: {error}</p>}
    </div>
  )
}
