import { useEffect, useState } from 'react'
import { RemoteFileTree } from './RemoteFileTree'
import { useTreeFolders } from './useTreeFolders'
import { useLaneChanges } from './useLaneChanges'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useHostResourceRevision } from '@/stores/hostResourceChanges'
import { hostFeatureRefusal } from '@/stores/hostRefusals'
import { useSessionsStore } from '@/stores/sessions'
import { CodeBlock } from '@/components/markdown/CodeBlock'
import { Button } from '@/components/form'
import { languageForPath } from '@/lib/languages'

/**
 * The Host serves reads only for the focused lane, and focus follows activation,
 * which lands after the session entry a pane mounts on. Reading earlier fails.
 */
const useActive = (sessionId: string): boolean =>
  useSessionsStore((s) => s.activeSessionId === sessionId)

/**
 * A browser lane's Changes: the files git reports changed against HEAD, each read as its HEAD
 * version then its working copy. Read only; the lane's Files edits.
 */
export function LaneChangesPane({ sessionId }: { sessionId: string }): React.JSX.Element {
  const entry = useSessionsStore((s) => s.live[sessionId])
  const hostId = entry?.target?.kind === 'remote' ? entry.target.hostId : null
  const host = useRemoteLanesStore((s) => (hostId ? s.hosts[hostId] : undefined))
  const [selected, setSelected] = useState('')
  // Held here: the tree unmounts while a file is open, and "← Changes" keeps its folders.
  const folders = useTreeFolders(selected || null, true)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const gitRevision = useHostResourceRevision(hostId, 'git')
  const workspace = entry?.workspacePath
  const refusal = hostFeatureRefusal(host, 'workspaces.read')
  const canRead = useActive(sessionId) && !refusal
  const epoch = host?.cursor?.epoch
  const token = host?.connectionToken
  const { status, loading } = useLaneChanges(
    workspace,
    { canRead, loading: !refusal },
    { epoch, token, refresh: refresh + gitRevision },
    setError,
  )
  const file = useChangedFile(
    { workspace, selected, canRead, refusal, status },
    { epoch, token, refresh: refresh + gitRevision },
    setError,
  )
  if (refusal)
    return (
      <p role="status" className="p-4">
        {refusal}
      </p>
    )
  return (
    <section aria-label="Changes" className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border p-2">
        {selected && <Button onClick={() => setSelected('')}>← Changes</Button>}
        <span className="min-w-0 flex-1 truncate">{selected || 'Changes'} · Read only</span>
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
            files={Object.keys(status)}
            status={status}
            selected={null}
            onSelect={setSelected}
            loading={loading}
            changes
          />
        ) : file.reading ? (
          <p role="status" className="p-4">
            Reading file…
          </p>
        ) : file.notice ? (
          <p className="p-4">{file.notice}</p>
        ) : (
          <ChangedFileView path={selected} content={file.content} before={file.before} />
        )}
      </div>
    </section>
  )
}

/** The selected changed file's working copy and HEAD version (null: none), read when it changes. */
function useChangedFile(
  {
    workspace,
    selected,
    canRead,
    refusal,
    status,
  }: {
    workspace: string | undefined
    selected: string
    canRead: boolean
    refusal: string | undefined
    status: Record<string, string>
  },
  { epoch, token, refresh }: { epoch?: string; token?: string; refresh: number },
  setError: (error: string) => void,
) {
  const [content, setContent] = useState('')
  const [before, setBefore] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [reading, setReading] = useState(false)
  useEffect(() => {
    let current = true
    setContent('')
    setBefore(null)
    setNotice('')
    setReading(!!selected && !refusal)
    if (canRead && workspace && selected)
      void Promise.all([
        status[selected]?.includes('D')
          ? Promise.resolve({ content: '', binary: false, tooLarge: false })
          : window.phosphor.invoke('fs:readFile', `${workspace}/${selected}`),
        status[selected] !== '??' && !status[selected]?.startsWith('A')
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
  }, [workspace, selected, refusal, canRead, status, epoch, token, refresh, setError])
  return { content, before, notice, reading }
}

/** One changed file in its language: its HEAD version (null: none), then its working copy. */
function ChangedFileView({
  path,
  content,
  before,
}: {
  path: string
  content: string
  before: string | null
}): React.JSX.Element {
  const language = languageForPath(path)
  return (
    <div className="h-full overflow-auto p-3">
      {typeof before === 'string' && (
        <>
          <h3>HEAD</h3>
          <CodeBlock code={before} language={language} chatActions={false} />
        </>
      )}
      <h3>Working copy</h3>
      <CodeBlock code={content} language={language} chatActions={false} />
    </div>
  )
}
