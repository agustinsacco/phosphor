import { useEffect, useRef, useState } from 'react'
import type { WorkspaceSessionStats } from '@shared/models'
import { useRemoteComposer } from './remoteComposer'
import { HostHome } from './HostHome'
import { LocalHomeDashboard } from './LocalHomeDashboard'
import { LocalHomeComposer } from './LocalHomeComposer'
import { RemoteStartView } from './RemoteStartView'
import { RemoteWorkspacePage } from './RemoteWorkspacePage'
import { useComposerMachine } from './useComposerMachine'
import { MachinePicker } from '@/features/machines/MachinePicker'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { prefetchTrunk } from '@/features/sessions/startChat'
import { projectName } from '@/lib/path'
import { homeDraftKey } from '@/stores/drafts'

/** Local workbench and shared remote creation, with independent dashboard and composer targets. */
export function WorkspaceHome({ workspacePath }: { workspacePath: string }): React.JSX.Element {
  const [composerMachine, setComposerMachine] = useComposerMachine()
  const target = useRemoteComposer((s) => s.target)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const filter = useRemoteLanesStore((s) => s.filter)
  const homeHostId = filter === 'local' || filter === 'all' ? null : filter
  const git = useSessionsStore((s) => s.gitByCwd[workspacePath])
  const dashboard = useLocalDashboard(workspacePath, homeHostId)
  useEffect(() => {
    if (!target) return
    setComposerMachine(target.hostId)
    textareaRef.current?.focus()
  }, [target, setComposerMachine])
  const machinePicker = (
    <MachinePicker
      placement="above"
      value={composerMachine}
      capability="sessions.control"
      onChange={setComposerMachine}
    />
  )
  if (composerMachine !== 'local' && homeHostId === composerMachine)
    return (
      <RemoteWorkspacePage
        hostId={composerMachine}
        draftKey={homeDraftKey(workspacePath)}
        textareaRef={textareaRef}
        machinePicker={machinePicker}
      />
    )
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-4 sm:px-8">
        <div className="w-full max-w-6xl pt-8 pb-6">
          {homeHostId ? (
            <HostHome hostId={homeHostId} />
          ) : (
            <LocalHomeDashboard
              workspacePath={workspacePath}
              workspaceName={projectName(workspacePath, git)}
              stats={dashboard.stats}
              username={dashboard.username}
              onNew={() => textareaRef.current?.focus()}
            />
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-center px-4 pb-6 pt-4 sm:px-6">
        <div className="relative w-full max-w-3xl">
          {composerMachine === 'local' ? (
            <LocalHomeComposer
              workspacePath={workspacePath}
              textareaRef={textareaRef}
              machinePicker={machinePicker}
            />
          ) : (
            <RemoteStartView
              key={`${composerMachine}:${workspacePath}`}
              hostId={composerMachine}
              draftKey={homeDraftKey(workspacePath)}
              textareaRef={textareaRef}
              machinePicker={machinePicker}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function useLocalDashboard(workspacePath: string, homeHostId: string | null) {
  const [stats, setStats] = useState<WorkspaceSessionStats | null>(null)
  const [username, setUsername] = useState('')
  useEffect(() => {
    if (homeHostId) return
    let current = true
    void window.phosphor
      .invoke('sessions:stats', workspacePath)
      .then((value) => {
        if (current) setStats(value)
      })
      .catch(() => {
        if (current) setStats(null)
      })
    void window.phosphor
      .invoke('app:userInfo')
      .then((info) => {
        if (!current) return
        const cleaned = info.username.replace(/[._-]+/g, ' ').trim()
        setUsername(cleaned.charAt(0).toUpperCase() + cleaned.slice(1))
      })
      .catch(() => {
        if (current) setUsername('')
      })
    prefetchTrunk(workspacePath)
    return () => {
      current = false
    }
  }, [workspacePath, homeHostId])
  return { stats, username }
}
