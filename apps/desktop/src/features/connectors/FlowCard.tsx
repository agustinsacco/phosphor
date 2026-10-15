import { TooltipButton } from '@/components/Tooltip'
import clsx from 'clsx'
import { Button } from '@/components/form'
import { useConnectorsStore, type ConnectFlow } from '@/stores/connectors'

/** What the authorization round-trip looks like while it is happening. */
export function FlowCard({
  serverName,
  flow,
}: {
  serverName: string
  flow: ConnectFlow
}): React.JSX.Element {
  const store = useConnectorsStore.getState()

  if (flow.phase === 'starting') {
    return <Note>Starting sign-in…</Note>
  }
  if (flow.phase === 'connected') {
    return (
      <Note tone="success">
        Signed in. <Dismiss onClick={() => store.dismiss(serverName)} />
      </Note>
    )
  }
  if (flow.phase === 'failed') {
    return (
      <Note tone="danger">
        {flow.message} <Dismiss onClick={() => store.dismiss(serverName)} />
      </Note>
    )
  }

  return (
    <div className="border-border bg-bg-secondary/40 mt-2 rounded-lg border px-3 py-2 text-sm">
      <div className="text-text">Approve access in your browser to finish signing in.</div>
      <div className="text-text-tertiary mt-1 break-all font-mono text-xs">
        {flow.authorizationUrl}
      </div>
      <div className="mt-2 flex items-center gap-2">
        {/* pi opened the page already; this is for a tab that got closed. */}
        <Button
          size="sm"
          onClick={() =>
            void window.phosphor.invoke('app:openExternal', flow.authorizationUrl).catch(() => {
              // The URL is on screen, so a blocked launch is recoverable.
            })
          }
        >
          Open again
        </Button>
        <Button size="sm" onClick={() => store.cancel(serverName)}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function Note({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'success' | 'danger'
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={clsx(
        'mt-2 rounded-lg border px-3 py-1.5 text-sm',
        tone === 'success' && 'border-success/30 bg-success/10 text-success',
        tone === 'danger' && 'border-danger/30 bg-danger-soft text-danger',
        tone === 'neutral' && 'border-border bg-bg-secondary/40 text-text-secondary',
      )}
    >
      {children}
    </div>
  )
}

function Dismiss({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <TooltipButton onClick={onClick} className="underline underline-offset-2">
      dismiss
    </TooltipButton>
  )
}
