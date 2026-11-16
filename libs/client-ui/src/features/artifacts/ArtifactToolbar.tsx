import clsx from 'clsx'
import { usePlatform } from '@/platform/Platform'
import { TooltipButton } from '@/components/Tooltip'
import { ResponsiveToolbar } from '@/components/ResponsiveToolbar'
import { CopyButton } from '@/components/CopyButton'
import { DownloadIcon, FileIcon, LinkIcon, PdfExportIcon } from '@/components/icons'
import type { Artifact } from '@/stores/artifacts'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { ipcErrorText } from '@shared/errors'

export type ViewMode = 'preview' | 'code' | 'diff'

interface ArtifactToolbarProps {
  artifact: Artifact
  shown: Artifact['versions'][number]
  mode: ViewMode
  setMode: (mode: ViewMode) => void
  selectVersion: (version: number) => void
  reference: string | null
  promoted: boolean
  copyReference: () => void
  saveTitle: string
  save: () => Promise<void>
  exporting: boolean
  downloads: string
  exportPdf: () => Promise<void>
  canWrite: boolean
  writeIn: { refusal: string | undefined }
  write: () => void
}

export function ArtifactToolbar(props: ArtifactToolbarProps): React.JSX.Element {
  const { canWrite, writeIn, write, reference, promoted, copyReference, shown } = props
  const referenceRefusal = reference
    ? undefined
    : promoted
      ? 'The agent cannot read a code block copied here.'
      : 'Available once pi reports the session.'
  return (
    <ResponsiveToolbar
      label="Artifact actions"
      primary={<CompactControls {...props} />}
      actions={[
        {
          label: 'Copy source',
          onClick: () => {
            void navigator.clipboard
              .writeText(shown.content)
              .catch((error: unknown) =>
                useExtensionUiStore.getState().pushToast(ipcErrorText(error), 'error'),
              )
          },
        },
        {
          label: 'Copy reference',
          hint: referenceRefusal,
          disabled: !reference,
          onClick: copyReference,
        },
        ...(canWrite
          ? [
              {
                label: 'Write in Files',
                hint: writeIn.refusal,
                disabled: !!writeIn.refusal,
                onClick: write,
              },
            ]
          : []),
      ]}
      expanded={<ExpandedControls {...props} />}
    />
  )
}

function CompactControls({
  artifact,
  shown,
  mode,
  setMode,
  selectVersion,
  saveTitle,
  save,
}: ArtifactToolbarProps): React.JSX.Element {
  const versioned = artifact.versions.length > 1
  return (
    <>
      <select
        aria-label="View"
        value={mode}
        onChange={(e) => setMode(e.target.value as ViewMode)}
        className="border-border bg-surface text-text h-11 rounded-md border px-2 text-[16px]"
      >
        <option value="preview">Preview</option>
        <option value="code">Code</option>
        {versioned && <option value="diff">Diff</option>}
      </select>
      {versioned && (
        <select
          aria-label="Version"
          value={shown.version}
          onChange={(e) => selectVersion(Number(e.target.value))}
          className="border-border bg-surface text-text h-11 rounded-md border px-1 text-[16px]"
        >
          {artifact.versions.map((v) => (
            <option key={v.version} value={v.version}>
              v{v.version}
            </option>
          ))}
        </select>
      )}
      <TooltipButton
        title={saveTitle}
        aria-label={saveTitle}
        onClick={() => void save()}
        className="text-text-secondary hover:bg-bg-secondary flex h-11 w-11 shrink-0 items-center justify-center rounded-md"
      >
        <DownloadIcon />
      </TooltipButton>
    </>
  )
}

function ExpandedViews({
  artifact,
  shown,
  mode,
  setMode,
  selectVersion,
}: ArtifactToolbarProps): React.JSX.Element {
  const versioned = artifact.versions.length > 1
  return (
    <>
      <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label="View">
        <Tab active={mode === 'preview'} onClick={() => setMode('preview')}>
          Preview
        </Tab>
        <Tab active={mode === 'code'} onClick={() => setMode('code')}>
          Code
        </Tab>
        {versioned && (
          <Tab active={mode === 'diff'} onClick={() => setMode('diff')}>
            Diff
          </Tab>
        )}
      </div>
      {versioned && (
        <select
          value={shown.version}
          data-tooltip="Version"
          aria-label="Version"
          onChange={(e) => {
            selectVersion(Number(e.target.value))
          }}
          className="border-border bg-surface text-text-secondary shrink-0 rounded-md border px-1 py-0.5 text-sm outline-none"
        >
          {artifact.versions.map((v) => (
            <option key={v.version} value={v.version}>
              v{v.version}
            </option>
          ))}
        </select>
      )}
    </>
  )
}

function ExpandedControls(props: ArtifactToolbarProps): React.JSX.Element {
  const {
    shown,
    reference,
    promoted,
    copyReference,
    saveTitle,
    save,
    exporting,
    downloads,
    exportPdf,
    canWrite,
    writeIn,
    write,
  } = props
  const platform = usePlatform()
  // Shrink and scroll so the shell's fullscreen/close buttons after this toolbar stay
  // reachable in a narrow pane; refusing to give ground would push them out of view.
  return (
    <div className="flex min-w-0 shrink items-center gap-1.5 overflow-x-auto [&::-webkit-scrollbar]:hidden">
      <ExpandedViews {...props} />
      <CopyButton text={shown.content} title="Copy source" className="shrink-0" />
      <ActionIcon
        title={
          reference
            ? 'Copy reference for a prompt'
            : promoted
              ? 'Copy reference (not for a code block copied here; the agent cannot read it)'
              : 'Copy reference (available once pi reports the session)'
        }
        disabled={!reference}
        onClick={copyReference}
      >
        <LinkIcon />
      </ActionIcon>
      <ActionIcon title={saveTitle} onClick={() => void save()}>
        <DownloadIcon />
      </ActionIcon>
      {/* PDF prints model HTML, which a browser could only do in the app's own origin. */}
      {platform.nativeFiles && (
        <ActionIcon
          title={exporting ? 'Exporting PDF…' : `Export preview to PDF (${downloads})`}
          disabled={exporting}
          onClick={() => void exportPdf()}
        >
          <PdfExportIcon />
        </ActionIcon>
      )}
      {canWrite && (
        <ActionIcon
          disabled={!!writeIn.refusal}
          title={writeIn.refusal ?? 'Write into workspace and open in Files'}
          onClick={write}
        >
          <FileIcon size={12} />
        </ActionIcon>
      )}
    </div>
  )
}

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <TooltipButton
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        'rounded-sm px-1.5 py-0.5 text-sm font-medium transition-colors',
        active ? 'bg-bg-secondary text-text' : 'text-text-tertiary hover:text-text',
      )}
    >
      {children}
    </TooltipButton>
  )
}

function ActionIcon({
  title,
  onClick,
  disabled = false,
  children,
}: {
  title: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <TooltipButton
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className="text-text-tertiary hover:text-text hover:bg-bg-secondary flex h-6 w-6 shrink-0 items-center justify-center rounded-sm transition-colors disabled:opacity-50"
    >
      {children}
    </TooltipButton>
  )
}
