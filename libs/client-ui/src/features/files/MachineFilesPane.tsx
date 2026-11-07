import { ListDetail } from '@/components/ListDetail'
import { Select } from '@/components/form'
import { usePlatform } from '@/platform/Platform'
import { RepositoryFilePreview } from './RepositoryFilePreview'
import { RemoteFileTree } from './RemoteFileTree'
import { useTreeFolders } from './useTreeFolders'
import { releaseFileModel } from './MonacoEditor'
import { useEffect, useState } from 'react'
import {
  useHostFiles,
  useLocalFiles,
  type MachineFileReads,
  type MachineFilesSource,
} from './machineFilesSource'

/**
 * A machine's files, read only: This Mac's (`'local'`) recent folders or a
 * Host's registered repositories. It never mounts the editor's tabs or a disk watcher.
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
type Repository = MachineFilesSource['repositories'][number]

/** A repository's files, read again with the reads or the repository; `path` is the one selected. */
function useMachineFileList(reads: MachineFileReads, repository: Repository | undefined) {
  const [files, setFiles] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [path, setPath] = useState('')
  // Held here, not in the tree, so a list that unmounts behind a preview keeps its folders.
  const folders = useTreeFolders(path || null)
  const { collapseAll } = folders
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    setLoading(Boolean(repository))
    setFiles([])
    setPath('')
    collapseAll()
    setError(null)
    if (repository)
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
  }, [reads, repository?.id, collapseAll])
  return { files, loading, path, setPath, error, folders }
}

/** The selected file's contents, and its editor model while the native editor shows it. */
function useMachineFilePreview(
  reads: MachineFileReads,
  repository: Repository | undefined,
  path: string,
) {
  const nativeEditor = usePlatform().fileEditing
  const [reading, setReading] = useState(false)
  const [binary, setBinary] = useState(false)
  const [preview, setPreview] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    setPreview('')
    setReading(Boolean(repository && path))
    setError(null)
    if (repository && path)
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
  }, [reads, repository?.id, path])
  const modelPath = repository && path ? reads.modelPath(repository.id, path) : ''
  useEffect(() => {
    if (!modelPath || !nativeEditor) return
    return () => releaseFileModel(modelPath)
  }, [modelPath, nativeEditor])
  return { nativeEditor, reading, binary, preview, modelPath, error }
}

function MachineFilesView({ source }: { source: MachineFilesSource }): React.JSX.Element {
  const [repositoryId, setRepositoryId] = useState('')
  // No repository while the machine is unavailable, so neither hook reads.
  const repository =
    source.unavailable === null ? source.repositories.find((r) => r.id === repositoryId) : undefined
  const { files, loading, path, setPath, ...list } = useMachineFileList(source.reads, repository)
  const file = useMachineFilePreview(source.reads, repository, path)
  const error = list.error ?? file.error
  const { noun } = source
  if (source.unavailable !== null) return <p className="p-4">{source.unavailable}</p>
  return (
    <section className="flex h-full flex-col gap-3 p-4" aria-label="Machine files">
      <h2 className="font-medium">
        {noun.many} <span className="text-text-secondary">Read only</span>
      </h2>
      <Select
        label={noun.one}
        value={repositoryId}
        onChange={setRepositoryId}
        options={[
          { value: '', label: `Choose a ${noun.one.toLowerCase()}` },
          ...source.repositories.map((r) => ({ value: r.id, label: r.name })),
        ]}
      />
      {error ? (
        <p role="alert">{error}</p>
      ) : (
        <ListDetail
          listLabel={`${noun.one} files`}
          detailLabel="File preview"
          list={
            <RemoteFileTree
              files={files}
              selected={path}
              onSelect={setPath}
              loading={loading}
              folders={list.folders}
            />
          }
          open={!!path}
          onBack={() => setPath('')}
          backLabel="Files"
          detail={(back) => (
            <RepositoryFilePreview
              back={back}
              nativeEditor={file.nativeEditor}
              path={path}
              resourcePath={file.modelPath}
              preview={file.preview}
              reading={file.reading}
              binary={file.binary}
            />
          )}
        />
      )}
    </section>
  )
}
