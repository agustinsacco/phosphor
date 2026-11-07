import { IconToggle } from '@/components/IconToggle'
import { Tag } from '@/components/form'
import { BranchIcon, CollapseAllIcon, FileIcon, ReloadIcon, SearchIcon } from '@/components/icons'
import { formatShortcut } from '@/lib/shortcuts'
import { useFilesStore } from '@/stores/files'
import { createIn, runFileAction } from './fileActions'
import { NewEntryIcon } from './fileIcons'
import type { FilesSource } from './filesSource'
import type { useExplorer } from './useExplorer'
import { useWorkspaceSearchStore } from './workspaceSearchStore'

/** The explorer header: what this lane's machine offers, and a read-only tag when it refuses writes. */
export function ExplorerToolbar({
  source,
  controls,
}: {
  source: FilesSource
  controls: ReturnType<typeof useExplorer>
}): React.JSX.Element {
  const { workspacePath, features, writeRefusal } = source
  return (
    <div className="border-border flex shrink-0 flex-wrap items-center justify-between gap-1 border-b px-2 py-1">
      <span className="text-text-tertiary text-xs font-semibold font-mono uppercase tracking-wider">
        Explorer
      </span>
      <div className="flex items-center gap-0.5">
        {writeRefusal && <Tag data-tooltip={writeRefusal}>Read only</Tag>}
        {features.search && (
          <IconToggle
            title={`Search in files (${formatShortcut('mod', 'shift', 'F')})`}
            onClick={() => useWorkspaceSearchStore.getState().openSearch(workspacePath)}
          >
            <SearchIcon size={12} />
          </IconToggle>
        )}
        {!writeRefusal &&
          (['file', 'folder'] as const).map((kind) => (
            <IconToggle
              key={kind}
              title={`New ${kind}`}
              onClick={() => runFileAction(createIn(workspacePath, controls.selected.at(-1), kind))}
            >
              <NewEntryIcon kind={kind} />
            </IconToggle>
          ))}
        <IconToggle
          title="Reveal active file"
          disabled={!controls.activePath}
          onClick={() => {
            if (controls.activePath)
              useFilesStore.getState().setActive(workspacePath, controls.activePath)
          }}
        >
          <FileIcon size={12} />
        </IconToggle>
        <IconToggle
          title="Collapse all folders"
          onClick={() =>
            useFilesStore.setState((s) => ({
              expanded: Object.fromEntries(
                Object.entries(s.expanded).map(([path, expanded]) => [
                  path,
                  path.startsWith(workspacePath + '/') || path.startsWith(workspacePath + '\\')
                    ? false
                    : expanded,
                ]),
              ),
            }))
          }
        >
          <CollapseAllIcon />
        </IconToggle>
        <IconToggle
          title="Refresh explorer"
          onClick={() => {
            const store = useFilesStore.getState()
            runFileAction(
              Promise.all([
                store.refreshLoadedDirs(workspacePath),
                store.refreshGitStatus(workspacePath),
              ]),
            )
          }}
        >
          <ReloadIcon />
        </IconToggle>
        {features.listOptions && <ListOptions workspacePath={workspacePath} />}
      </div>
    </div>
  )
}

/** The hidden-files and .gitignore toggles, where the machine lists with options. */
function ListOptions({ workspacePath }: { workspacePath: string }): React.JSX.Element {
  const showHidden = useFilesStore((s) => s.showHidden)
  const respectGitignore = useFilesStore((s) => s.respectGitignore)
  return (
    <>
      <IconToggle
        title="Show hidden files"
        pressed={showHidden}
        onClick={() => useFilesStore.getState().setShowHidden(workspacePath, !showHidden)}
      >
        <EyeIcon />
      </IconToggle>
      <IconToggle
        title="Respect .gitignore"
        pressed={respectGitignore}
        onClick={() =>
          useFilesStore.getState().setRespectGitignore(workspacePath, !respectGitignore)
        }
      >
        <BranchIcon size={12} />
      </IconToggle>
    </>
  )
}

function EyeIcon(): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}
