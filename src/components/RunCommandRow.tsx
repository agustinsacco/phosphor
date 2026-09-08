import { useState } from 'react'
import { CopyButton } from './CopyButton'
import { Button } from './form'

/**
 * A fix presented as one runnable command: the command in mono, a play button
 * that sends it to the session terminal, and copy for the "I'll run it
 * elsewhere" case.
 *
 * Used wherever Phosphor can name the exact shell fix for a failure (expired SSO
 * token, missing login) so the user never has to go hunt for the incantation.
 */
export function RunCommandRow({
  command,
  label = 'Run',
  workspacePath,
  onRun,
}: {
  command: string
  label?: string
  /** Spawn cwd fallback for the terminal; omit to disable the play button. */
  workspacePath?: string
  /** Called after the command is sent (e.g. to retry the failed turn). */
  onRun?: () => void
}): React.JSX.Element {
  const [ran, setRan] = useState(false)

  const run = (): void => {
    if (!workspacePath) return
    setRan(true)
    void import('@/stores/terminal').then(({ runInTerminal }) =>
      runInTerminal(workspacePath, command, { execute: true }),
    )
    onRun?.()
  }

  return (
    <div className="border-border bg-code-bg mt-2 flex items-center gap-2 rounded-lg border px-2 py-1.5">
      <code className="text-text min-w-0 flex-1 truncate font-mono text-base" title={command}>
        {command}
      </code>
      <CopyButton text={command} />
      {workspacePath && (
        <Button
          variant="primary"
          size="xs"
          onClick={run}
          title={`Run in the session terminal: ${command}`}
          className="flex shrink-0 items-center gap-1.5"
        >
          <PlayIcon />
          {ran ? 'Ran' : label}
        </Button>
      )}
    </div>
  )
}

function PlayIcon(): React.JSX.Element {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5v14l11-7z" />
    </svg>
  )
}
