import { useState } from 'react'
import { Button } from '@/components/form'
import { TooltipSummary } from '@/components/Tooltip'
import {
  HOST_GUIDE,
  HOST_INSTALL,
  HOST_RUN,
  HOST_SERVICE_INSTALL,
  HOST_SERVICE_STATUS,
} from './machinePresentation'

export function CopyCommand({ command }: { command: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  return (
    <div className="border-border bg-bg-secondary flex items-start gap-3 rounded-md border px-3 py-2.5">
      {/* A wrapped shell line reads as two commands: scroll instead. */}
      <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all py-0.5 font-mono text-base">
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
    <div className="space-y-3 text-base">
      <p className="text-text-secondary">
        Run this in a terminal on the other machine. It installs Phosphor to ~/.local/bin, sets up
        the machine and prints a code to approve here.
      </p>
      {collapsed ? (
        <details>
          <TooltipSummary>Show install command</TooltipSummary>
          <CopyCommand command={HOST_INSTALL} />
        </details>
      ) : (
        <CopyCommand command={HOST_INSTALL} />
      )}
      <p className="text-text-secondary text-sm">
        The installer adds ~/.local/bin to your shell startup file for future sessions. To opt out,
        set PHOSPHOR_NO_MODIFY_PATH=1 in the installer's environment.
      </p>
    </div>
  )
}

/** The Host service commands in the order to try them, closed until asked for. */
export function Troubleshooting({
  summary = 'Troubleshooting',
  children,
}: {
  summary?: string
  /** What to check first, before the commands. */
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <details className="text-text-secondary space-y-2 text-base">
      <TooltipSummary className="cursor-pointer">{summary}</TooltipSummary>
      {children}
      <p>1. Check the Host service.</p>
      <CopyCommand command={HOST_SERVICE_STATUS} />
      <p>2. If no service is installed, install it.</p>
      <CopyCommand command={HOST_SERVICE_INSTALL} />
      <p>3. For debugging, run the Host in the foreground.</p>
      <CopyCommand command={HOST_RUN} />
    </details>
  )
}
