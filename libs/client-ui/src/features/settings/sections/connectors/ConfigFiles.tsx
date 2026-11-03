import { lazy, Suspense, useState } from 'react'
import type { McpScope } from '@shared/mcp'
import { TooltipButton } from '@/components/Tooltip'
import { ChevronIcon } from '@/components/icons'
import type { ConnectorsSource } from './source'

/** The raw editor loads its editor only once a file is opened. */
const McpFileEditor = lazy(() =>
  import('../../ConfigFileEditor').then(({ ConfigFileEditor, mcpConfigFile }) => ({
    default: (props: { scope: McpScope; workspacePath?: string; onClose: () => void }) => (
      <ConfigFileEditor
        source={mcpConfigFile(props.scope, props.workspacePath)}
        onClose={props.onClose}
      />
    ),
  })),
)

const SCOPE_LABELS: Record<McpScope, string> = { global: 'machine', project: 'folder' }

/** Repair tools, not daily controls: both mcp.json files and their raw editor. */
export function ConfigFiles({
  files,
  onClosed,
}: {
  files: NonNullable<ConnectorsSource['files']>
  onClosed: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<McpScope | null>(null)
  return (
    <>
      <TooltipButton
        onClick={() => setOpen((a) => !a)}
        aria-expanded={open}
        className="text-text-tertiary hover:text-text mt-6 flex items-center gap-1.5 text-base"
      >
        <ChevronIcon size={8} expanded={open} />
        Advanced
      </TooltipButton>
      {open && (
        <div className="mt-2">
          <h4 className="text-base font-semibold">Config files</h4>
          <p className="text-text-tertiary mt-0.5 text-sm">
            A folder entry replaces the machine one with the same name; one with no command or url
            only turns it on or off, or changes its exposure.
          </p>
          <div className="border-border divide-border mt-2 divide-y rounded-lg border">
            {files.states.map((file) => (
              <div key={file.scope} className="flex items-center gap-2 px-3 py-1.5 text-base">
                <span className="text-text-secondary w-20 shrink-0">
                  {SCOPE_LABELS[file.scope]}
                </span>
                <span
                  className="text-text-tertiary min-w-0 flex-1 truncate font-mono text-sm"
                  data-tooltip={file.path}
                >
                  {file.path}
                </span>
                {file.malformed ? (
                  <span className="text-danger shrink-0 text-sm" data-tooltip={file.error}>
                    malformed
                  </span>
                ) : file.exists ? (
                  <span className="text-text-tertiary shrink-0 text-sm">
                    {file.serverNames.length} server{file.serverNames.length === 1 ? '' : 's'}
                  </span>
                ) : (
                  <span className="text-text-tertiary/60 shrink-0 text-sm">absent</span>
                )}
                <TooltipButton
                  onClick={() => setEditing(file.scope)}
                  className="text-text-tertiary hover:text-text shrink-0 text-sm underline-offset-2 hover:underline"
                >
                  Edit
                </TooltipButton>
              </div>
            ))}
          </div>
        </div>
      )}
      {editing && (
        <Suspense fallback={null}>
          <McpFileEditor
            scope={editing}
            workspacePath={files.workspacePath}
            onClose={() => {
              setEditing(null)
              onClosed()
            }}
          />
        </Suspense>
      )}
    </>
  )
}
