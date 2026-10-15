import { useRemoteFileSelection, releaseRemoteFileSelection } from './remoteFileSelection'
import { RemoteFileTree } from './RemoteFileTree'
import { IconToggle } from './FileExplorer'
import {
  FileIcon,
  PlusIcon,
  RefreshIcon,
  CheckIcon,
  ChangesIcon,
  CloseIcon,
  BranchIcon,
} from '@/components/icons'
import { useEffect, useState, useRef } from 'react'
import { TooltipButton } from '@/components/Tooltip'
import { MonacoDiff, MonacoEditor, releaseFileModel } from './MonacoEditor'
import { languageForPath } from '@/lib/monaco'
import { useRemoteLanesStore, REMOTE_UNAVAILABLE, REMOTE_NOT_READY } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { canControlSession } from '@/stores/remoteLanes'
import { promptText } from '@/stores/prompt'

/** Remote content stays in memory. No local preview protocols or filesystem watcher. */
export function RemoteFilesPane(props: {
  workspacePath: string
  sessionId: string
  changes: boolean
}): React.JSX.Element {
  return <RemoteFilesView key={`${props.sessionId}:${props.workspacePath}`} {...props} />
}
function RemoteFilesView({
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
  const [loading, setLoading] = useState(false)
  const [files, setFiles] = useState<string[]>([])
  const [gitUnavailable, setGitUnavailable] = useState(false)
  const [status, setStatus] = useState<Record<string, string>>({})
  const selection = useRemoteFileSelection((s) => s.bySession[sessionId])
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [before, setBefore] = useState('')
  const [revision, setRevision] = useState<string | null | undefined>()
  const [editable, setEditable] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty
  const writable =
    host?.state === 'ready' &&
    host.capabilities.includes('workspaces.write') &&
    canControlSession(sessionId)
  useEffect(() => {
    if (selection) setSelected(selection.path)
  }, [selection])
  useEffect(() => {
    useRemoteFileSelection.setState((s) => ({
      blocked: { ...s.blocked, [sessionId]: dirty || busy },
    }))
  }, [sessionId, dirty, busy])
  useEffect(() => () => releaseRemoteFileSelection(sessionId), [sessionId])
  const [error, setError] = useState<string | null>(null)
  const available = host?.state === 'ready' && host.capabilities.includes('workspaces.read')
  const laneId = useSessionsStore((s) => s.live[sessionId]?.laneId)
  // Host objects are replaced by unrelated lanes and control/stream updates.
  const summary = JSON.stringify(host?.lanes.find((lane) => lane.laneId === laneId))
  const connectionState = host?.state
  const runtimeEpoch = host?.cursor?.epoch
  useEffect(() => {
    let alive = true
    setLoading(available)
    setFiles([])
    setStatus({})
    if (available)
      void Promise.all([
        window.phosphor.invoke('fs:listFiles', workspacePath),
        window.phosphor.invoke('git:statusMap', workspacePath).catch(() => null),
      ]).then(
        ([files, status]) => {
          if (alive) {
            setLoading(false)
            setFiles(files)
            setGitUnavailable(status === null)
            setStatus(status ?? {})
            setError(null)
          }
        },
        () => {
          if (alive) {
            setLoading(false)
            setError(REMOTE_UNAVAILABLE)
          }
        },
      )
    return () => {
      alive = false
    }
  }, [workspacePath, available, summary, connectionState, runtimeEpoch, refresh])
  useEffect(() => {
    let alive = true
    if (dirtyRef.current) return
    setContent('')
    setBefore('')
    setEditable(false)
    setRevision(undefined)
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
            setUncertain(false)
            setRevision('revision' in file ? file.revision : undefined)
            setEditable(!changes && !file.binary && !file.tooLarge && 'revision' in file)
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
  useEffect(() => {
    if (!selected) return
    const path = `remote:${sessionId}/${selected}`
    return () => releaseFileModel(path)
  }, [sessionId, selected])
  async function save() {
    if (!selected || !writable || !editable || busy || uncertain || revision === undefined) return
    setBusy(true)
    try {
      const result = await window.phosphor.invoke(
        'fs:writeFile',
        `${workspacePath}/${selected}`,
        content,
        revision,
      )
      setRevision(result.revision)
      setDirty(false)
      setError(null)
    } catch (error) {
      if (!(error instanceof Error && error.message.includes('changed-on-disk'))) setUncertain(true)
      setError(
        error instanceof Error && error.message.includes('changed-on-disk')
          ? 'File changed on disk. Discard your edits and refresh before saving.'
          : 'Save not confirmed. Your edits are kept. Do not retry an uncertain save.',
      )
    } finally {
      setBusy(false)
    }
  }
  async function action(kind: 'file' | 'directory' | 'rename' | 'delete' | 'copy' | 'move') {
    if (!writable || busy || dirty) return
    const value = await promptText({
      title:
        kind === 'delete'
          ? 'Type the path to confirm deletion'
          : kind === 'copy' || kind === 'move'
            ? 'Destination folder (lane-relative, . for root)'
            : 'Lane-relative path',
      initialValue: kind === 'rename' || kind === 'delete' ? (selected ?? '') : '',
    })
    if (!value || (kind === 'delete' && value !== selected)) return
    setBusy(true)
    try {
      const path = `${workspacePath}/${value}`
      if (kind === 'file') await window.phosphor.invoke('fs:createFile', path)
      if (kind === 'directory') await window.phosphor.invoke('fs:createDir', path)
      if (kind === 'rename' && selected)
        await window.phosphor.invoke('fs:rename', `${workspacePath}/${selected}`, path)
      if (kind === 'delete') await window.phosphor.invoke('fs:trash', path)
      if ((kind === 'copy' || kind === 'move') && selected)
        await window.phosphor.invoke(
          'fs:transfer',
          workspacePath,
          `${workspacePath}/${selected}`,
          value === '.' ? workspacePath : path,
          kind,
        )
      setSelected(null)
      setRefresh((n) => n + 1)
      setError(null)
    } catch {
      setError('File action not confirmed.')
    } finally {
      setBusy(false)
    }
  }
  if (!available && !(dirty && selected))
    return (
      <p className="p-4">
        {host && host.state !== 'ready' ? REMOTE_NOT_READY : REMOTE_UNAVAILABLE}
      </p>
    )
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="border-border flex shrink-0 flex-wrap items-center gap-1 border-b px-2 py-1">
        <span className="text-text-tertiary mr-auto text-xs font-semibold font-mono uppercase tracking-wider">
          {changes ? 'Changes' : 'Explorer'}
        </span>
        {!writable && 'Read-only '}
        <IconToggle title="Refresh" active={false} onClick={() => setRefresh((n) => n + 1)}>
          <RefreshIcon />
        </IconToggle>
        {writable && !changes && (
          <>
            <IconToggle
              title="New file"
              active={false}
              disabled={busy || dirty}
              onClick={() => void action('file')}
            >
              <FileIcon />
            </IconToggle>
            <IconToggle
              title="New folder"
              active={false}
              disabled={busy || dirty}
              onClick={() => void action('directory')}
            >
              <PlusIcon />
            </IconToggle>
            <IconToggle
              title="Rename"
              active={false}
              disabled={busy || dirty || !selected}
              onClick={() => void action('rename')}
            >
              <ChangesIcon />
            </IconToggle>
            <IconToggle
              title="Trash"
              active={false}
              disabled={busy || dirty || !selected}
              onClick={() => void action('delete')}
            >
              <CloseIcon />
            </IconToggle>
            <IconToggle
              title="Copy to folder"
              active={false}
              disabled={busy || dirty || !selected}
              onClick={() => void action('copy')}
            >
              <PlusIcon />
            </IconToggle>
            <IconToggle
              title="Move to folder"
              active={false}
              disabled={busy || dirty || !selected}
              onClick={() => void action('move')}
            >
              <BranchIcon />
            </IconToggle>
            <IconToggle
              title="Save"
              active={false}
              disabled={busy || uncertain || !dirty || !editable}
              onClick={() => void save()}
            >
              <CheckIcon />
            </IconToggle>
          </>
        )}
        {dirty && (
          <TooltipButton
            className="text-accent rounded-sm px-2 py-1 text-sm hover:bg-bg-secondary"
            disabled={busy}
            onClick={() => {
              setDirty(false)
              dirtyRef.current = false
              setRefresh((n) => n + 1)
            }}
          >
            {uncertain ? 'Reload file' : 'Discard edits'}
          </TooltipButton>
        )}
      </div>
      {!available && (
        <p role="status" className="text-text-tertiary border-border border-b px-3 py-2 text-sm">
          {host?.state === 'ready' ? REMOTE_UNAVAILABLE : 'Reconnecting… Unsaved edits are kept.'}
        </p>
      )}
      {gitUnavailable && (
        <p role="status" className="text-text-tertiary px-3 py-2 text-sm">
          Git status is unavailable.
        </p>
      )}
      {(uncertain || error) && (
        <p
          role="alert"
          className="text-danger bg-danger/5 border-border border-b px-3 py-2 text-sm"
        >
          {uncertain
            ? 'Save not confirmed. Your edits are kept. Do not retry an uncertain save.'
            : error}
        </p>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="border-border bg-bg-secondary/40 w-1/3 min-w-36 overflow-auto border-r">
          <RemoteFileTree
            files={changes ? Object.keys(status) : files}
            status={status}
            selected={selected}
            disabled={dirty || busy}
            onSelect={setSelected}
            loading={loading}
            changes={changes}
          />
        </div>
        <div className="min-w-0 flex-1 overflow-auto">
          {changes && selected ? (
            <MonacoDiff
              originalText={before}
              modifiedText={content}
              language={languageForPath(selected)}
              renderSideBySide={false}
            />
          ) : selected && editable ? (
            <MonacoEditor
              path={`remote:${sessionId}/${selected}`}
              reveal={selection?.path === selected ? selection.reveal : undefined}
              language={languageForPath(selected)}
              value={content}
              readOnly={!writable || busy}
              onChange={(value) => {
                setContent(value)
                setDirty(true)
              }}
              onSave={() => void save()}
            />
          ) : (
            <pre className="text-text-secondary p-4 text-sm">
              {selected ? content : 'Select a file to preview'}
            </pre>
          )}
        </div>
      </div>
    </div>
  )
}
