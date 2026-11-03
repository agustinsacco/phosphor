import { Button, SectionTitle, SettingsNotice } from '@/components/form'
import { SandboxList } from './SandboxList'
import type { FolderItem, FolderSource } from './source'

/**
 * The folders a machine runs lanes in, on every machine: This Mac's recent
 * folders and sandboxes, or a Host's registered folders and their trust.
 */
export function FoldersView({ source }: { source: FolderSource }): React.JSX.Element {
  const { caps, folders, busy } = source
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <SectionTitle>Folders</SectionTitle>
          <p className="text-text-tertiary -mt-2 text-base">{source.intro}</p>
        </div>
        {caps.add && (
          <Button disabled={busy} onClick={source.add}>
            Add folder
          </Button>
        )}
      </div>
      {source.notice && <SettingsNotice {...source.notice} />}
      {folders.length === 0 && <p className="text-text-tertiary text-base">No folders yet.</p>}
      <div className="border-border divide-border divide-y overflow-hidden rounded-xl border">
        {folders.map((folder) => (
          <FolderRow key={folder.id} folder={folder} source={source} />
        ))}
      </div>
      {caps.trustReview && (
        <p className="text-text-tertiary mt-2 text-sm">
          Project trust permits pi to load a folder’s project configuration and executable MCP
          commands. Review that code before approving.
        </p>
      )}
      {caps.sandboxes && <SandboxList />}
      {source.addDialog}
    </div>
  )
}

function FolderRow({
  folder,
  source,
}: {
  folder: FolderItem
  source: FolderSource
}): React.JSX.Element {
  const { caps, busy } = source
  return (
    <div className="bg-surface flex flex-wrap items-center gap-3 px-4 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-lg font-medium">{folder.name}</span>
        <span className="text-text-tertiary block truncate text-sm">{folder.path}</span>
      </span>
      {caps.trustReview && (
        <Button size="xs" disabled={busy} onClick={() => source.reviewTrust(folder)}>
          Review project trust
        </Button>
      )}
      {caps.remove && (
        <Button size="xs" disabled={busy} onClick={() => void source.remove(folder)}>
          {caps.remove === 'unregister' ? 'Unregister' : 'Remove'}
        </Button>
      )}
    </div>
  )
}
