import { ListDetail } from '@/components/ListDetail'
import { usePlatform } from '@/platform/Platform'
import { RepositoryFilePreview } from './RepositoryFilePreview'
import { RemoteFileTree } from './RemoteFileTree'
import { releaseFileModel } from './MonacoEditor'
import { useEffect, useState } from 'react'
import { REMOTE_NOT_READY, REMOTE_UNAVAILABLE, useRemoteLanesStore } from '@/stores/remoteLanes'
import { fileListErrorText } from '@shared/host-protocol-files'

/** Machine repository previews never mount the local editor or disk watcher. */
export function MachineFilesPane({ hostId }: { hostId: string }): React.JSX.Element {
  return <MachineFilesView key={hostId} hostId={hostId} />
}
function MachineFilesView({ hostId }: { hostId: string }): React.JSX.Element {
  const nativeEditor = usePlatform().fileEditing
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const [repositoryId, setRepositoryId] = useState('')
  const [files, setFiles] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [reading, setReading] = useState(false)
  const [binary, setBinary] = useState(false)
  const [preview, setPreview] = useState('')
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
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
    setError(null)
    if (ready && repository)
      void window.phosphor.invoke('hosts:repositoryFiles', hostId, repository.id).then(
        (result) => {
          if (current) {
            setLoading(false)
            setFiles(result)
          }
        },
        (failure: unknown) => {
          if (current) {
            setLoading(false)
            setError(fileListErrorText(failure, REMOTE_UNAVAILABLE))
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
    setError(null)
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
            setError(REMOTE_UNAVAILABLE)
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
        <p role="alert">{error}</p>
      ) : (
        <ListDetail
          listLabel="Repository files"
          detailLabel="File preview"
          list={
            <RemoteFileTree files={files} selected={path} onSelect={setPath} loading={loading} />
          }
          open={!!path}
          onBack={() => setPath('')}
          backLabel="Files"
          detail={(back) => (
            <RepositoryFilePreview
              back={back}
              nativeEditor={nativeEditor}
              path={path}
              resourcePath={`host:${hostId}/repository:${repositoryId}/${path}`}
              preview={preview}
              reading={reading}
              binary={binary}
            />
          )}
        />
      )}
    </section>
  )
}
