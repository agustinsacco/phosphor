import { useEffect, useRef, useState } from 'react'
import { RemoteFileTree } from './RemoteFileTree'
import { useTreeFolders } from './useTreeFolders'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { hostFeatureRefusal } from '@/stores/hostRefusals'
import { useSessionsStore } from '@/stores/sessions'
import { useRemoteFileSelection } from './remoteFileSelection'
import { CodeBlock } from '@/components/markdown/CodeBlock'
import { Button } from '@/components/form'
import { languageForPath } from '@/lib/languages'
import type { PendingReveal } from '@/stores/files'
import { useLineReveal } from './useLineReveal'
import { TextFilePreview } from './TextFilePreview'

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
  // Held here: the tree unmounts while a file is open, and "← Files" keeps its folders.
  const folders = useTreeFolders(selected || null, changes)
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
  const refusal = hostFeatureRefusal(host, 'workspaces.read')
  const canRead = useActive(sessionId) && !refusal
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
    setLoading(!refusal)
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
  }, [workspace, refusal, canRead, epoch, token, changes, refresh])
  useEffect(() => {
    let current = true
    setContent('')
    setBefore(null)
    setNotice('')
    setReading(!!selected && !refusal)
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
  }, [workspace, selected, refusal, canRead, changes, status, epoch, token, refresh])
  if (refusal)
    return (
      <p role="status" className="p-4">
        {refusal}
      </p>
    )
  return (
    <section aria-label={changes ? 'Changes' : 'Files'} className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border p-2">
        {selected && <Button onClick={() => setSelected('')}>← Files</Button>}
        <span className="min-w-0 flex-1 truncate">
          {selected || (changes ? 'Changes' : 'Files')} · Read only
        </span>
        {!selected && <Button onClick={folders.collapseAll}>Collapse all</Button>}
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
            folders={folders}
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
          <ReadOnlyFileView
            path={selected}
            content={content}
            before={changes ? before : undefined}
            reveal={!changes && selection?.path === selected ? selection.reveal : undefined}
          />
        )}
      </div>
    </section>
  )
}

/** One file as text in the lane's language; Changes puts its HEAD version (null: none) first. */
function ReadOnlyFileView({
  path,
  content,
  before,
  reveal,
}: {
  path: string
  content: string
  before?: string | null
  reveal?: PendingReveal
}): React.JSX.Element {
  const scroller = useRef<HTMLDivElement>(null)
  useLineReveal(scroller, reveal, content)
  const language = languageForPath(path)
  const text = (
    <div ref={scroller} className="h-full overflow-auto p-3">
      {typeof before === 'string' && (
        <>
          <h3>HEAD</h3>
          <CodeBlock code={before} language={language} chatActions={false} />
        </>
      )}
      {before !== undefined && <h3>Working copy</h3>}
      <CodeBlock code={content} language={language} chatActions={false} />
    </div>
  )
  if (before !== undefined) return text
  return <TextFilePreview path={path} content={content} reveal={reveal} source={text} />
}
