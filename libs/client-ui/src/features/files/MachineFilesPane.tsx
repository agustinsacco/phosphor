import { usePlatform } from '@/platform/Platform'
import { RepositoryFilePreview } from './RepositoryFilePreview'
import { RemoteFileTree } from './RemoteFileTree'
import { releaseFileModel } from './MonacoEditor'
import { useEffect, useState } from 'react'
import { REMOTE_NOT_READY, REMOTE_UNAVAILABLE, useRemoteLanesStore } from '@/stores/remoteLanes'

/** Machine repository previews never mount the local editor or disk watcher. */
export function MachineFilesPane({ hostId }: { hostId: string }): React.JSX.Element {
  return <MachineFilesView key={hostId} hostId={hostId} />
}
function MachineFilesView({ hostId }: { hostId: string }): React.JSX.Element {
  const platform = usePlatform()
  const compact = platform.formFactor === 'compact'
  const nativeEditor = platform.fileEditing
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const [repositoryId, setRepositoryId] = useState('')
  const [files, setFiles] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [reading, setReading] = useState(false)
  const [binary, setBinary] = useState(false)
  const [preview, setPreview] = useState('')
  const [path, setPath] = useState('')
  const [error, setError] = useState(false)
  const ready = host?.state === 'ready' && host.capabilities.includes('workspaces.read')
  const repository = host?.repositories.find((r) => r.id === repositoryId)
  useEffect(() => {
    setRepositoryId('')
    setPath('')
  }, [hostId])
  useEffect(() => {
    let current = true
    setLoading(Boolean(ready && repository))
    setFiles([])
    setPath('')
    setError(false)
    if (ready && repository)
      void window.phosphor.invoke('hosts:repositoryFiles', hostId, repository.id).then(
        (result) => {
          if (current) {
            setLoading(false)
            setFiles(result)
          }
        },
        () => {
          if (current) {
            setLoading(false)
            setError(true)
          }
        },
      )
    return () => {
      current = false
    }
  }, [hostId, repository?.id, ready])
  useEffect(() => {
    let current = true
    setPreview('')
    setReading(Boolean(ready && repository && path))
    setError(false)
    if (ready && repository && path)
      void window.phosphor.invoke('hosts:repositoryFile', hostId, repository.id, path).then(
        (result) => {
          if (current) {
            setReading(false)
            setBinary(result.binary)
            setPreview(result.binary ? 'Binary file' : result.content)
          }
        },
        () => {
          if (current) {
            setReading(false)
            setError(true)
          }
        },
      )
    return () => {
      current = false
    }
  }, [hostId, repository?.id, ready, path])
  useEffect(() => {
    if (!path || !nativeEditor) return
    return () => releaseFileModel(`host:${hostId}/repository:${repositoryId}/${path}`)
  }, [hostId, repositoryId, path, nativeEditor])
  if (!ready)
    return <p className="p-4">{host?.state !== 'ready' ? REMOTE_NOT_READY : REMOTE_UNAVAILABLE}</p>
  return (
    <section className="flex h-full flex-col gap-3 p-4" aria-label="Machine files">
      <h2 className="font-medium">
        Repositories <span className="text-text-secondary">Read only</span>
      </h2>
      <select
        aria-label="Repository"
        value={repositoryId}
        onChange={(e) => setRepositoryId(e.target.value)}
        className="bg-surface rounded border p-2"
      >
        <option value="">Choose a repository</option>
        {host.repositories.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
      {error ? (
        <p role="alert">{REMOTE_UNAVAILABLE}</p>
      ) : (
        <div className={`flex min-h-0 flex-1 gap-4 ${compact ? 'flex-col' : ''}`}>
          {(!compact || !path) && (
            <nav
              aria-label="Repository files"
              className={`border-border bg-bg-secondary/40 overflow-auto ${compact ? 'flex-1' : 'w-1/3 border-r'}`}
            >
              <RemoteFileTree files={files} selected={path} onSelect={setPath} loading={loading} />
            </nav>
          )}
          <div aria-label="File preview" className="min-w-0 flex-1 overflow-hidden">
            <RepositoryFilePreview
              compact={compact}
              nativeEditor={nativeEditor}
              path={path}
              resourcePath={`host:${hostId}/repository:${repositoryId}/${path}`}
              preview={preview}
              reading={reading}
              binary={binary}
              onBack={() => setPath('')}
            />
          </div>
        </div>
      )}
    </section>
  )
}
