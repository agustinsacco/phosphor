import { useEffect, useState } from 'react'
import { TooltipButton } from '@/components/Tooltip'
import { MonacoDiff } from './MonacoEditor'
import { languageForPath } from '@/lib/monaco'
import { useRemoteLanesStore, REMOTE_UNAVAILABLE } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'

/** Remote reads never mount the local editor, preview protocols or filesystem watcher. */
export function RemoteFilesPane({
  workspacePath,
  sessionId,
  changes,
}: {
  workspacePath: string
  sessionId: string
  changes: boolean
}): React.JSX.Element {
  const hostId = useSessionsStore((s) => {
    const target = s.live[sessionId]?.target
    return target?.kind === 'remote' ? target.hostId : undefined
  })
  const host = useRemoteLanesStore((s) => (hostId ? s.hosts[hostId] : undefined))
  const [refresh, setRefresh] = useState(0)
  const [files, setFiles] = useState<string[]>([])
  const [status, setStatus] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [before, setBefore] = useState('')
  const [error, setError] = useState<string | null>(null)
  const available = host?.state === 'ready' && host.capabilities.includes('workspaces.read')
  const laneId = useSessionsStore((s) => s.live[sessionId]?.laneId)
  // Host objects are replaced by unrelated lanes and control/stream updates.
  const summary = JSON.stringify(host?.lanes.find((lane) => lane.laneId === laneId))
  const connectionState = host?.state
  const runtimeEpoch = host?.cursor?.epoch
  useEffect(() => {
    let alive = true
    setFiles([])
    setStatus({})
    if (available)
      void Promise.all([
        window.phosphor.invoke('fs:listFiles', workspacePath),
        window.phosphor.invoke('git:statusMap', workspacePath),
      ]).then(
        ([files, status]) => {
          if (alive) {
            setFiles(files)
            setStatus(status)
            setError(null)
          }
        },
        () => {
          if (alive) setError(REMOTE_UNAVAILABLE)
        },
      )
    return () => {
      alive = false
    }
  }, [workspacePath, available, summary, connectionState, runtimeEpoch, refresh])
  useEffect(() => {
    let alive = true
    setContent('')
    setBefore('')
    if (selected && available)
      void Promise.all([
        changes && status[selected]?.includes('D')
          ? Promise.resolve({ content: '', binary: false, tooLarge: false })
          : window.phosphor.invoke('fs:readFile', `${workspacePath}/${selected}`),
        changes && status[selected] !== '??' && !status[selected]?.startsWith('A')
          ? window.phosphor
              .invoke('git:showFileAt', workspacePath, 'HEAD', selected)
              .catch(() => undefined)
          : Promise.resolve(null),
      ]).then(
        ([file, old]) => {
          if (alive) {
            setContent(
              file.binary ? 'Binary file' : file.tooLarge ? 'File too large' : file.content,
            )
            // A failed HEAD read (undefined) keeps the current file and says so, rather
            // than showing a message as if it were the file's earlier content.
            setBefore(old ?? '')
            setError(old === undefined ? 'The HEAD version could not be read.' : null)
          }
        },
        () => {
          if (alive) setError(REMOTE_UNAVAILABLE)
        },
      )
    return () => {
      alive = false
    }
  }, [workspacePath, selected, changes, available, refresh, status])
  if (!available) return <p className="p-4">{REMOTE_UNAVAILABLE}</p>
  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto p-3">
      <div>
        Read-only <TooltipButton onClick={() => setRefresh((n) => n + 1)}>Refresh</TooltipButton>
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="w-1/3 overflow-auto">
          {(changes ? Object.keys(status) : files).map((path) => (
            <TooltipButton className="block text-left" key={path} onClick={() => setSelected(path)}>
              {status[path]} {path}
            </TooltipButton>
          ))}
        </div>
        <div className="min-w-0 flex-1 overflow-auto">
          {changes && selected ? (
            <MonacoDiff
              originalText={before}
              modifiedText={content}
              language={languageForPath(selected)}
              renderSideBySide={false}
            />
          ) : (
            <pre>{content}</pre>
          )}
        </div>
      </div>
    </div>
  )
}
