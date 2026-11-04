import { ListDetail } from '@/components/ListDetail'
import { Select } from '@/components/form'
import { usePlatform } from '@/platform/Platform'
import { RepositoryFilePreview } from './RepositoryFilePreview'
import { RemoteFileTree } from './RemoteFileTree'
import { releaseFileModel } from './MonacoEditor'
import { useEffect, useState } from 'react'
import { useHostFiles, useLocalFiles, type MachineFilesSource } from './machineFilesSource'

/**
 * A machine's repositories, read only: This Mac's (`'local'`) recent folders or
 * a Host's registered repositories. It never mounts the editor's tabs or a disk watcher.
 */
export function MachineFilesPane({ hostId }: { hostId: string }): React.JSX.Element {
  return hostId === 'local' ? (
    <LocalMachineFiles />
  ) : (
    <HostMachineFiles key={hostId} hostId={hostId} />
  )
}
function LocalMachineFiles(): React.JSX.Element {
  return <MachineFilesView source={useLocalFiles()} />
}
function HostMachineFiles({ hostId }: { hostId: string }): React.JSX.Element {
  return <MachineFilesView source={useHostFiles(hostId)} />
}
function MachineFilesView({ source }: { source: MachineFilesSource }): React.JSX.Element {
  const nativeEditor = usePlatform().fileEditing
  const [repositoryId, setRepositoryId] = useState('')
  const [files, setFiles] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [reading, setReading] = useState(false)
  const [binary, setBinary] = useState(false)
  const [preview, setPreview] = useState('')
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const ready = source.unavailable === null
  const repository = source.repositories.find((r) => r.id === repositoryId)
  const { reads } = source
  useEffect(() => {
    let current = true
    setLoading(Boolean(ready && repository))
    setFiles([])
    setPath('')
    setError(null)
    if (ready && repository)
      void reads.list(repository.id).then(
        (result) => {
          if (current) {
            setLoading(false)
            setFiles(result)
          }
        },
        (failure: unknown) => {
          if (current) {
            setLoading(false)
            setError(reads.listError(failure))
          }
        },
      )
    return () => {
      current = false
    }
  }, [reads, repository?.id, ready])
  useEffect(() => {
    let current = true
    setPreview('')
    setReading(Boolean(ready && repository && path))
    setError(null)
    if (ready && repository && path)
      void reads.read(repository.id, path).then(
        (result) => {
          if (current) {
            setReading(false)
            setBinary(result.binary)
            setPreview(result.content)
          }
        },
        () => {
          if (current) {
            setReading(false)
            setError(reads.readError)
          }
        },
      )
    return () => {
      current = false
    }
  }, [reads, repository?.id, ready, path])
  const modelPath = path ? reads.modelPath(repositoryId, path) : ''
  useEffect(() => {
    if (!modelPath || !nativeEditor) return
    return () => releaseFileModel(modelPath)
  }, [modelPath, nativeEditor])
  if (!ready) return <p className="p-4">{source.unavailable}</p>
  return (
    <section className="flex h-full flex-col gap-3 p-4" aria-label="Machine files">
      <h2 className="font-medium">
        Repositories <span className="text-text-secondary">Read only</span>
      </h2>
      <Select
        label="Repository"
        value={repositoryId}
        onChange={setRepositoryId}
        options={[
          { value: '', label: 'Choose a repository' },
          ...source.repositories.map((r) => ({ value: r.id, label: r.name })),
        ]}
      />
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
              resourcePath={modelPath}
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
