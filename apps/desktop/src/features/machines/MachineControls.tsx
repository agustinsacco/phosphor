import { useState } from 'react'
import { Button } from '@/components/form'
import { TooltipSummary } from '@/components/Tooltip'
import { HOST_GUIDE, HOST_INSTALL, HOST_SETUP, HOST_LOGIN } from './machinePresentation'

export function CopyCommand({ command }: { command: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  return (
    <div className="border-border bg-bg-secondary flex items-start gap-3 rounded-md border px-3 py-2.5">
      {/* A wrapped shell line reads as two commands: scroll instead. */}
      <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre py-0.5 font-mono text-base">
        <code>{command}</code>
      </pre>
      <Button
        size="xs"
        title={`Copy ${command}`}
        onClick={() => {
          void navigator.clipboard.writeText(command).then(
            () => {
              setCopied(true)
              setFailed(false)
            },
            () => setFailed(true),
          )
        }}
      >
        {failed ? 'Try again' : copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}
export function HostGuide(): React.JSX.Element {
  return (
    <a
      href={HOST_GUIDE}
      className="text-text-secondary hover:text-text underline underline-offset-4"
      onClick={(event) => {
        event.preventDefault()
        void window.phosphor.invoke('app:openExternal', HOST_GUIDE)
      }}
    >
      Host guide ↗
    </a>
  )
}
export function HostSetup({ collapsed = false }: { collapsed?: boolean }): React.JSX.Element {
  return (
    <ol className="space-y-4 text-base">
      <li>
        <p className="mb-2 font-medium">1. Install the Host from source</p>
        <p className="text-text-secondary mb-2">
          An installer comes later. Node 22.19 or newer and git are required.
        </p>
        {collapsed ? (
          <details>
            <TooltipSummary className="text-text-secondary mb-2 cursor-pointer">
              Show install commands
            </TooltipSummary>
            <CopyCommand command={HOST_INSTALL} />
          </details>
        ) : (
          <CopyCommand command={HOST_INSTALL} />
        )}
      </li>
      <li>
        <p className="mb-2 font-medium">2. Set up the machine</p>
        <CopyCommand command={HOST_SETUP} />
        <p className="text-text-secondary mt-1.5">
          Choose your project folder. Inside a git repository, you can leave off --repository.
        </p>
      </li>
      <li>
        <p className="mb-2 font-medium">3. Get a code</p>
        <CopyCommand command={HOST_LOGIN} />
      </li>
    </ol>
  )
}
