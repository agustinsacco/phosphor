import { useState } from 'react'
import { Button } from '@/components/form'
import { useWorkspacesStore } from '@/stores/workspaces'
import type { AgentKind } from '@shared/models'

export function WorkspacePicker({
  agent = 'pi',
  piVersion,
}: {
  agent?: AgentKind
  piVersion?: string
}): React.JSX.Element {
  const { recents, pickAndOpen, openWorkspace, openSandbox } = useWorkspacesStore()
  // The native folder dialog takes a beat to appear; without this the button
  // gives no feedback and a second click queues a second dialog.
  const [picking, setPicking] = useState(false)

  const pick = async (): Promise<void> => {
    if (picking) return
    setPicking(true)
    try {
      await pickAndOpen()
    } finally {
      setPicking(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Full-width screen, so this must clear the Windows/Linux controls
          overlay as well as macOS's traffic lights: h-11 = TITLEBAR_HEIGHT. */}
      <div className="titlebar-drag h-11 shrink-0" />
      <div className="flex flex-1 flex-col items-center justify-center gap-8 px-8 pb-16">
        <div className="text-center">
          <h1 className="text-4xl font-semibold tracking-tight">What are we building today?</h1>
          <p className="text-text-secondary mt-2 text-lg">
            Open a project folder to start a coding session with {agent}
            {piVersion ? ` ${piVersion}` : ''}.
          </p>
        </div>

        <Button
          variant="primary"
          size="xl"
          onClick={() => void pick()}
          disabled={picking}
          aria-busy={picking}
          className="shadow-sm"
        >
          {picking ? 'Opening…' : 'Open Folder…'}
        </Button>

        <button
          onClick={() => void openSandbox()}
          className="text-text-secondary hover:text-text -mt-4 cursor-pointer text-base underline-offset-4 transition-colors hover:underline"
          title="Start in a fresh sandbox folder that belongs to no project"
        >
          or start without a folder
        </button>

        {recents.length > 0 && (
          <div className="w-full max-w-md">
            <div className="text-text-tertiary mb-2 text-base font-medium uppercase tracking-wider">
              Recent workspaces
            </div>
            <div className="bg-surface border-border overflow-hidden rounded-lg border">
              {recents.slice(0, 6).map((ws) => (
                <button
                  key={ws.path}
                  onClick={() => openWorkspace(ws.path)}
                  className="hover:bg-bg-secondary border-border flex w-full items-center gap-3 border-b px-4 py-3 text-left transition-colors last:border-b-0"
                >
                  <span className="text-xl">📁</span>
                  <span className="flex-1 truncate">
                    <span className="block text-lg font-medium">{ws.name}</span>
                    <span className="text-text-tertiary block truncate text-base">{ws.path}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
