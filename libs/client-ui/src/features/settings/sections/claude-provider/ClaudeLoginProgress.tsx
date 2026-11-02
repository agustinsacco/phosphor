import { TooltipButton } from '@/components/Tooltip'
import type { ClaudeLoginState } from '@shared/models'
import { Button, TextInput } from '@/components/form'
import { Spinner } from '@/components/icons'

/** The browser handoff: spinner, error, and the code the user pastes back. */
export function ClaudeLoginProgress({
  code,
  login,
  onCode,
  onSubmit,
}: {
  code: string
  login: ClaudeLoginState | null
  onCode: (code: string) => void
  onSubmit: () => void
}): React.JSX.Element | null {
  if (login === null) return null
  return (
    <div>
      {login.phase === 'starting' && (
        <div className="text-text-secondary mt-3 flex items-center gap-2 text-sm">
          <Spinner />
          Starting the Claude CLI’s sign-in…
        </div>
      )}

      {login.phase === 'finishing' && (
        <div className="text-text-secondary mt-3 flex items-center gap-2 text-sm">
          <Spinner />
          Finishing sign-in…
        </div>
      )}

      {login.phase === 'error' && <p className="text-danger mt-3 text-sm">{login.message}</p>}

      {login.phase === 'awaiting-code' && (
        <div className="border-border bg-surface-raised mt-3 rounded-md border p-3">
          {login.invalidCode && (
            <p className="text-danger text-sm">
              That code wasn’t accepted. Use the fresh link below — the earlier one has expired.
            </p>
          )}
          {/* The paste-back step is the one people miss: the CLI's OAuth
              redirect lands on a page showing a code, and nothing on screen
              says it has to come back here. */}
          <p className="text-text-secondary text-sm">
            Finish in the browser, then paste the code Claude shows you:
          </p>
          <div className="mt-2 flex items-center gap-2">
            <TextInput
              autoFocus
              value={code}
              onChange={(event) => onCode(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onSubmit()
              }}
              placeholder="Paste code"
              className="min-w-0 flex-1 rounded-md font-mono"
            />
            <Button variant="primary" disabled={!code.trim()} onClick={onSubmit}>
              Continue
            </Button>
          </div>
          <TooltipButton
            onClick={() => void window.phosphor.invoke('app:openExternal', login.url)}
            className="text-accent mt-2.5 block text-sm hover:underline"
          >
            Browser didn’t open? Open the sign-in page
          </TooltipButton>
        </div>
      )}
    </div>
  )
}
