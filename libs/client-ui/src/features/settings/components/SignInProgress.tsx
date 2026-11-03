import { useState } from 'react'
import { TooltipButton } from '@/components/Tooltip'
import type { ClaudeLoginState, LoginFlowState } from '@shared/models'
import { Button, TextInput } from '@/components/form'
import { CopyButton } from '@/components/CopyButton'
import { Spinner } from '@/components/icons'

/**
 * The middle of an in-app sign-in, for pi's providers and Claude accounts
 * alike: the step under way, then the browser handoff with what the user must
 * do there (type pi's device code on the page, or paste back Claude's code).
 */
export function SignInProgress({
  flow,
  who,
  onSubmit,
}: {
  flow: ClaudeLoginState | LoginFlowState | null
  /** Whose sign-in starts: "pi", "the Claude CLI". */
  who: string
  onSubmit?: (code: string) => void
}): React.JSX.Element | null {
  const [code, setCode] = useState('')
  const submit = (): void => {
    if (!code.trim() || !onSubmit) return
    onSubmit(code.trim())
    setCode('')
  }
  if (flow?.phase === 'starting' || flow?.phase === 'finishing')
    return (
      <Step className="mt-3">
        {flow.phase === 'starting' ? `Starting ${who}’s sign-in…` : 'Finishing sign-in…'}
      </Step>
    )
  if (flow?.phase === 'error') return <p className="text-danger mt-3 text-sm">{flow.message}</p>
  if (flow?.phase !== 'awaiting-browser' && flow?.phase !== 'awaiting-code') return null
  return (
    <div className="border-border bg-surface-raised mt-3 rounded-md border p-3">
      {flow.phase === 'awaiting-browser' ? (
        <Step>Waiting for you to finish in your browser.</Step>
      ) : flow.invalidCode ? (
        <p className="text-danger text-sm">
          That code wasn’t accepted. Use the fresh link below — the earlier one has expired.
        </p>
      ) : null}
      {flow.phase === 'awaiting-browser' && flow.userCode && (
        // The device code is the step people miss: the browser page asks for it.
        <div className="mt-2.5">
          <p className="text-text-tertiary text-sm">Enter this code on the page:</p>
          <div className="mt-1 flex items-center gap-2">
            <code className="border-border bg-surface rounded border px-2 py-1 font-mono text-base tracking-widest">
              {flow.userCode}
            </code>
            <CopyButton text={flow.userCode} label="Copy" size="sm" />
          </div>
        </div>
      )}
      {flow.phase === 'awaiting-code' && (
        // The paste-back step is the one people miss too: the CLI's OAuth redirect
        // lands on a page showing a code, and nothing says it has to come back here.
        <>
          <p className="text-text-secondary text-sm">
            Finish in the browser, then paste the code Claude shows you:
          </p>
          <div className="mt-2 flex items-center gap-2">
            <TextInput
              autoFocus
              value={code}
              onChange={(event) => setCode(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && submit()}
              placeholder="Paste code"
              className="min-w-0 flex-1 rounded-md font-mono"
            />
            <Button variant="primary" disabled={!code.trim()} onClick={submit}>
              Continue
            </Button>
          </div>
        </>
      )}
      {/* The fallback when the browser did not open on its own. */}
      <TooltipButton
        onClick={() => void window.phosphor.invoke('app:openExternal', flow.url)}
        className="text-accent mt-2.5 block text-sm hover:underline"
      >
        Browser didn’t open? Open the sign-in page again
      </TooltipButton>
    </div>
  )
}

function Step({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={`text-text-secondary flex items-center gap-2 text-sm ${className ?? ''}`}>
      <Spinner />
      {children}
    </div>
  )
}
