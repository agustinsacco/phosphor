import { useEffect, useRef, useState, type ReactNode } from 'react'
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

/**
 * Local workbench and shared remote creation, with independent dashboard and composer targets.
 * `localSetup` takes This Mac's place while it cannot start a lane (no pi, no folder): the whole
 * home, or on a Host home only the composer slot, under the composer's machine picker. A Host
 * composer target on a local home then gets its full start page.
 */
export function WorkspaceHome({
  workspacePath,
  localSetup,
}: {
  workspacePath: string
  localSetup?: ReactNode
}): React.JSX.Element {
  const [composerMachine, setComposerMachine] = useComposerMachine()
  const target = useRemoteComposer((s) => s.target)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const filter = useRemoteLanesStore((s) => s.filter)
  const homeHostId = filter === 'local' || filter === 'all' ? null : filter
  const git = useSessionsStore((s) => s.gitByCwd[workspacePath])
  const dashboard = useLocalDashboard(workspacePath, !homeHostId && !localSetup)
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
  if (composerMachine === 'local' && localSetup && !homeHostId) return <>{localSetup}</>
  if (
    composerMachine !== 'local' &&
    (homeHostId === composerMachine || (localSetup && !homeHostId))
  )
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
          {composerMachine === 'local' && localSetup ? (
            // The picker stays outside the scroll box, so its menu opens above unclipped.
            <>
              <div className="flex justify-center">{machinePicker}</div>
              <div className="max-h-[50vh] overflow-y-auto">{localSetup}</div>
            </>
          ) : composerMachine === 'local' ? (
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

function useLocalDashboard(workspacePath: string, shown: boolean) {
  const [stats, setStats] = useState<WorkspaceSessionStats | null>(null)
  const [username, setUsername] = useState('')
  useEffect(() => {
    if (!shown) return
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
  }, [workspacePath, shown])
  return { stats, username }
}
