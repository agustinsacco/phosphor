import { useEffect, useState } from 'react'
import { RemoteFileTree } from './RemoteFileTree'
import { useRemoteLanesStore, REMOTE_NOT_READY, REMOTE_UNAVAILABLE } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useRemoteFileSelection } from './remoteFileSelection'
import { CodeBlock } from '@/components/markdown/CodeBlock'
import { Button } from '@/components/form'

/**
 * The Host serves reads only for the focused lane, and focus follows activation,
 * which lands after the session entry a pane mounts on. Reading earlier fails.
 */
const useActive = (sessionId: string): boolean =>
  useSessionsStore((s) => s.activeSessionId === sessionId)

/** The phone reads the same lane resources without mounting an editor or write controls. */
export function ReadOnlyFilesPane({
  sessionId,
  changes = false,
}: {
  sessionId: string
  changes?: boolean
}): React.JSX.Element {
  const entry = useSessionsStore((s) => s.live[sessionId])
  const host = useRemoteLanesStore((s) =>
    entry?.target?.kind === 'remote' ? s.hosts[entry.target.hostId] : undefined,
  )
  const selection = useRemoteFileSelection((s) => s.bySession[sessionId])
  const [selected, setSelected] = useState(selection?.path ?? '')
  const [files, setFiles] = useState<string[]>([])
  const [status, setStatus] = useState<Record<string, string>>({})
  const [content, setContent] = useState('')
  const [before, setBefore] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [reading, setReading] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const workspace = entry?.workspacePath
  const ready = host?.state === 'ready' && host.capabilities.includes('workspaces.read')
  const canRead = useActive(sessionId) && ready
  const epoch = host?.cursor?.epoch
  const token = host?.connectionToken
  useEffect(() => {
    if (selection) setSelected(selection.path)
  }, [selection])
  useEffect(() => {
    let current = true
    setError('')
    setFiles([])
    setStatus({})
    setLoading(!!ready)
    if (canRead && workspace)
      void Promise.all([
        window.phosphor.invoke('fs:listFiles', workspace),
        changes ? window.phosphor.invoke('git:statusMap', workspace) : Promise.resolve({}),
      ]).then(
        ([files, status]) => {
          if (current) {
            setFiles(files)
            setStatus(status)
            setLoading(false)
          }
        },
        () => {
          if (current) {
            setError('Could not read files.')
            setLoading(false)
          }
        },
      )
    return () => {
      current = false
    }
  }, [workspace, ready, canRead, epoch, token, changes, refresh])
  useEffect(() => {
    let current = true
    setContent('')
    setBefore(null)
    setNotice('')
    setReading(!!selected && !!ready)
    if (canRead && workspace && selected)
      void Promise.all([
        changes && status[selected]?.includes('D')
          ? Promise.resolve({ content: '', binary: false, tooLarge: false })
          : window.phosphor.invoke('fs:readFile', `${workspace}/${selected}`),
        changes && status[selected] !== '??' && !status[selected]?.startsWith('A')
          ? window.phosphor.invoke('git:showFileAt', workspace, 'HEAD', selected)
          : Promise.resolve(null),
      ]).then(
        ([file, old]) => {
          if (!current) return
          setReading(false)
          setError('')
          setBefore(old)
          setNotice(
            file.binary
              ? 'Binary file. Preview unavailable.'
              : file.tooLarge
                ? 'File too large to preview.'
                : '',
          )
          setContent(file.binary || file.tooLarge ? '' : file.content)
        },
        () => {
          if (current) {
            setReading(false)
            setError('Could not read this file or its HEAD version.')
          }
        },
      )
    return () => {
      current = false
    }
  }, [workspace, selected, ready, canRead, changes, status, epoch, token, refresh])
  if (!ready)
    return (
      <p role="status" className="p-4">
        {host?.state !== 'ready' ? REMOTE_NOT_READY : REMOTE_UNAVAILABLE}
      </p>
    )
  return (
    <section aria-label={changes ? 'Changes' : 'Files'} className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border p-2">
        {selected && <Button onClick={() => setSelected('')}>← Files</Button>}
        <span className="min-w-0 flex-1 truncate">
          {selected || (changes ? 'Changes' : 'Files')} · Read only
        </span>
        <Button onClick={() => setRefresh((n) => n + 1)}>Refresh</Button>
      </header>
      {error ? (
        <p role="alert" className="p-4">
          {error}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        {!selected ? (
          <RemoteFileTree
            files={changes ? Object.keys(status) : files}
            status={status}
            selected={null}
            onSelect={setSelected}
            loading={loading}
            changes={changes}
          />
        ) : reading ? (
          <p role="status" className="p-4">
            Reading file…
          </p>
        ) : notice ? (
          <p className="p-4">{notice}</p>
        ) : (
          <div className="p-3">
            {changes && before !== null && (
              <>
                <h3>HEAD</h3>
                <CodeBlock code={before} language="text" />
              </>
            )}
            {changes && <h3>Working copy</h3>}
            <CodeBlock code={content} language="text" />
          </div>
        )}
      </div>
    </section>
  )
}
