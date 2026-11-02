import { useState } from 'react'
import { TooltipButton } from '@/components/Tooltip'
import type { ClaudeLoginState } from '@shared/models'
import { Button, TextInput } from '@/components/form'
import { Spinner } from '@/components/icons'

const STEP = { starting: 'Starting the Claude CLI’s sign-in…', finishing: 'Finishing sign-in…' }

/** The browser handoff: spinner, error, and the code the user pastes back. */
export function ClaudeLoginProgress({
  login,
  onSubmit,
}: {
  login: ClaudeLoginState | null
  onSubmit?: (code: string) => void
}): React.JSX.Element | null {
  const [code, setCode] = useState('')
  const submit = (): void => {
    if (!code.trim() || !onSubmit) return
    onSubmit(code.trim())
    setCode('')
  }
  if (login === null) return null
  if (login.phase === 'starting' || login.phase === 'finishing')
    return <LoginStep className="mt-3">{STEP[login.phase]}</LoginStep>
  if (login.phase === 'error') return <p className="text-danger mt-3 text-sm">{login.message}</p>
  if (login.phase !== 'awaiting-code') return null
  return (
    <div className="border-border bg-surface-raised mt-3 rounded-md border p-3">
      {login.invalidCode && (
        <p className="text-danger text-sm">
          That code wasn’t accepted. Use the fresh link below — the earlier one has expired.
        </p>
      )}
      {/* The paste-back step is the one people miss: the CLI's OAuth redirect
          lands on a page showing a code, and nothing says it has to come back here. */}
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
      <ReopenSignIn url={login.url} />
    </div>
  )
}

/** A sign-in step in progress. Shared with pi's provider sign-in. */
export function LoginStep({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={`text-text-secondary flex items-center gap-2 text-sm ${className ?? ''}`}>
      <Spinner />
      {children}
    </div>
  )
}

/** The fallback when the browser did not open on its own. */
export function ReopenSignIn({ url }: { url: string }): React.JSX.Element {
  return (
    <TooltipButton
      onClick={() => void window.phosphor.invoke('app:openExternal', url)}
      className="text-accent mt-2.5 block text-sm hover:underline"
    >
      Browser didn’t open? Open the sign-in page again
    </TooltipButton>
  )
}
