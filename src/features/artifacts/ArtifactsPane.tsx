import { memo, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { useArtifactsStore, type Artifact } from '@/stores/artifacts'
import { useSessionsStore } from '@/stores/sessions'
import { openFileInWorkspace } from '@/stores/layout'
import { PaneShell, PaneTitle } from '@/components/PaneShell'
import { PopupMenu, MenuRow } from '@/components/PopupMenu'
import { ChevronDownIcon } from '@/components/icons'
import { Markdown } from '@/components/markdown/Markdown'
import { CodeBlock } from '@/components/markdown/CodeBlock'
import { MermaidBlock } from '@/components/markdown/MermaidBlock'
import { ChartBlock } from '@/components/markdown/ChartBlock'
import { MonacoDiff } from '@/features/files/MonacoEditor'
import { CopyButton } from '@/components/CopyButton'
import { SandboxedHtml } from '@/components/SandboxedHtml'
import { DownloadIcon, FileIcon, PdfExportIcon } from '@/components/icons'
import { relativeTimeShort } from '@/lib/time'
import { useSettingsStore } from '@/stores/settings'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { ipcErrorText } from '@shared/errors'
import { artifactGlyph, artifactLanguage, suggestedFileName } from './artifactKinds'
import {
  needsRenderedPreview,
  previewReadySelector,
  printableHtml,
  serializePreview,
  waitForPreview,
} from './previewHtml'

type ViewMode = 'preview' | 'code' | 'diff'

/** Right-pane Artifacts region: gallery + versioned viewer. */
export const ArtifactsPane = memo(function ArtifactsPane({
  workspacePath,
}: {
  workspacePath: string
}): React.JSX.Element {
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const artifacts = useArtifactsStore((s) =>
    activeSessionId ? s.bySession[activeSessionId] : undefined,
  )
  const selectedId = useArtifactsStore((s) =>
    activeSessionId ? s.selected[activeSessionId] : undefined,
  )
  const requestedVersion = useArtifactsStore((s) =>
    activeSessionId ? s.selectedVersion[activeSessionId] : undefined,
  )

  useEffect(() => {
    if (activeSessionId) useArtifactsStore.getState().clearUnseen(activeSessionId)
  })

  const list = useMemo(
    () => Object.values(artifacts ?? {}).sort((a, b) => b.updatedAt - a.updatedAt),
    [artifacts],
  )
  const selected = (selectedId && artifacts?.[selectedId]) || list[0]

  if (!activeSessionId || !selected) {
    return (
      <PaneShell title={<PaneTitle label="Artifacts" />}>
        <div className="flex h-full items-center justify-center px-6">
          <div className="text-center">
            <div className="text-text-tertiary text-lg">No artifacts yet</div>
            <div className="text-text-tertiary mt-1 text-sm">
              Ask for a dashboard mockup, diagram or report — substantial deliverables land here
              with version history.
            </div>
          </div>
        </div>
      </PaneShell>
    )
  }

  return (
    <ArtifactWorkspace
      key={selected.id}
      artifact={selected}
      list={list}
      workspacePath={workspacePath}
      onSelect={(id) => useArtifactsStore.getState().select(activeSessionId, id)}
      requestedVersion={selected.id === selectedId ? requestedVersion : undefined}
    />
  )
})

/**
 * One artifact: header chrome plus body.
 *
 * The chrome is ONE row. It used to be four stacked bands (shell label,
 * gallery chips, title band, viewer toolbar); the switcher dropdown replaced
 * the chips and the title band, and the toolbar now rides in PaneShell's
 * `actions` slot beside it. Header and body are separate PaneShell slots but
 * share tab + version state, so they are one component — remounted per
 * artifact by its `key`, which is what resets the view on a switch.
 */
function ArtifactWorkspace({
  artifact,
  list,
  workspacePath,
  onSelect,
  requestedVersion,
}: {
  artifact: Artifact
  list: Artifact[]
  workspacePath: string
  onSelect: (id: string) => void
  /** Version explicitly navigated to (e.g. a chat card's "Open in panel"). */
  requestedVersion?: number
}): React.JSX.Element {
  const latest = artifact.versions[artifact.versions.length - 1]!
  const [mode, setMode] = useState<ViewMode>('preview')
  const [exporting, setExporting] = useState(false)
  // The PDF prints the rendered preview, so the export reads this node for the
  // types React draws — and the staged document carries the app's theme, the
  // same way the preview iframe does.
  const previewRef = useRef<HTMLDivElement>(null)
  const theme = useSettingsStore((s) => s.resolvedTheme)
  const [versionIndex, setVersionIndex] = useState<number>(() => {
    const requested = artifact.versions.findIndex((v) => v.version === requestedVersion)
    return requested >= 0 ? requested : artifact.versions.length - 1
  })

  // A version-targeted navigation (chat card click) wins over current state.
  useEffect(() => {
    if (requestedVersion == null) return
    const requested = artifact.versions.findIndex((v) => v.version === requestedVersion)
    if (requested >= 0) setVersionIndex(requested)
  }, [requestedVersion, artifact.versions])

  // Follow the tip only when the user was already at it — a reader pinned to
  // an older version (comparing, reviewing) must not be yanked to latest by
  // an incoming update.
  const prevLengthRef = useRef(artifact.versions.length)
  useEffect(() => {
    const prevLength = prevLengthRef.current
    prevLengthRef.current = artifact.versions.length
    setVersionIndex((current) =>
      current >= prevLength - 1 ? artifact.versions.length - 1 : current,
    )
  }, [artifact.versions.length])

  const shown = artifact.versions[Math.min(versionIndex, artifact.versions.length - 1)] ?? latest
  const previous = artifact.versions[Math.min(versionIndex, artifact.versions.length - 1) - 1]
  const versioned = artifact.versions.length > 1

  const save = async (): Promise<void> => {
    const outputPath = await window.phosphor.invoke('app:saveDialog', {
      title: 'Save artifact',
      defaultPath: suggestedFileName(artifact),
    })
    if (!outputPath) return
    await window.phosphor.invoke('fs:writeFile', outputPath, shown.content)
    await window.phosphor.invoke('app:revealPath', outputPath)
  }

  const openInFiles = async (): Promise<void> => {
    const target = `${workspacePath}/${suggestedFileName(artifact)}`
    await window.phosphor.invoke('fs:writeFile', target, shown.content)
    await openFileInWorkspace(workspacePath, target)
  }

  /**
   * Print what the preview shows.
   *
   * The types the renderer draws (markdown, mermaid, chart, code) are
   * serialised from the live DOM, so the pane has to be ON the preview tab and
   * finished rendering — a click from the Code tab switches back and waits
   * rather than exporting a blank page. Both outcomes speak: a silent success
   * was indistinguishable from a dead button, which is how this shipped.
   */
  const exportPdf = async (): Promise<void> => {
    if (exporting) return
    setExporting(true)
    try {
      let rendered: string | undefined
      if (needsRenderedPreview(artifact.type)) {
        setMode('preview')
        const node = await waitForPreview(
          () => previewRef.current,
          previewReadySelector(artifact.type),
        )
        if (!node) throw new Error('The preview is still rendering — try again in a moment.')
        rendered = serializePreview(node)
      }
      const { savedTo } = await window.phosphor.invoke('artifacts:exportPdf', {
        html: printableHtml(artifact.type, shown.content, rendered),
        title: shown.title,
        theme,
      })
      const fileName = savedTo.split(/[/\\]/).pop()
      useExtensionUiStore.getState().pushToast(`PDF saved to Downloads — ${fileName}`)
    } catch (error) {
      useExtensionUiStore.getState().pushToast(ipcErrorText(error), 'error')
    } finally {
      setExporting(false)
    }
  }

  return (
    <PaneShell
      title={<ArtifactSwitcher list={list} selected={artifact} onSelect={onSelect} />}
      actions={
        /*
         * Shrinkable and scrollable, following the terminal's tab strip: the
         * shell's own ↔ / ↗ / ✕ come AFTER this in the row, so a toolbar that
         * refused to give ground would push them out of a narrow pane and
         * leave no way to close it. The pane title (flex-basis 0) collapses
         * first; only then does this scroll.
         */
        <div className="flex min-w-0 shrink items-center gap-1.5 overflow-x-auto [&::-webkit-scrollbar]:hidden">
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
              title="Version"
              aria-label="Version"
              onChange={(e) => {
                const index = artifact.versions.findIndex(
                  (v) => v.version === Number(e.target.value),
                )
                if (index !== -1) setVersionIndex(index)
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
          <CopyButton text={shown.content} className="shrink-0" />
          <ActionIcon title="Save source to file…" onClick={() => void save()}>
            <DownloadIcon />
          </ActionIcon>
          <ActionIcon
            title={exporting ? 'Exporting PDF…' : 'Export preview to PDF (Downloads)'}
            disabled={exporting}
            onClick={() => void exportPdf()}
          >
            <PdfExportIcon />
          </ActionIcon>
          <ActionIcon
            title="Write into workspace and open in Files"
            onClick={() => void openInFiles()}
          >
            <FileIcon size={12} />
          </ActionIcon>
        </div>
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="artifact-scroll">
        {mode === 'preview' && (
          // `display:contents`: the export needs a node to read the rendered
          // preview from, and this one must not become a box — the HTML
          // preview's iframe sizes against the scroll container, so a real
          // wrapper here would change what every artifact looks like.
          <div ref={previewRef} className="contents">
            <ArtifactPreview artifact={artifact} content={shown.content} />
          </div>
        )}
        {mode === 'code' && (
          <div className="[&_.code-block]:my-0 [&_.code-block]:rounded-none [&_.code-block]:border-0">
            <CodeBlock code={shown.content} language={artifactLanguage(artifact)} />
          </div>
        )}
        {mode === 'diff' && (
          <div className="h-full">
            <MonacoDiff
              originalText={previous?.content ?? ''}
              modifiedText={shown.content}
              language={artifactLanguage(artifact)}
              renderSideBySide={false}
            />
          </div>
        )}
      </div>
    </PaneShell>
  )
}

/**
 * Header title = the selected artifact itself (glyph, name). With more than
 * one artifact it becomes a dropdown switcher; with one it is a plain label.
 *
 * No timestamp here: it cost ~45px of a row that also carries the tabs, the
 * version picker and the shell's buttons, and the dropdown already dates every
 * artifact.
 */
function ArtifactSwitcher({
  list,
  selected,
  onSelect,
}: {
  list: Artifact[]
  selected: Artifact
  onSelect: (id: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const multiple = list.length > 1

  return (
    <div className="relative min-w-0 flex-1">
      <button
        ref={triggerRef}
        disabled={!multiple}
        aria-haspopup={multiple ? 'listbox' : undefined}
        aria-expanded={multiple ? open : undefined}
        title={multiple ? 'Switch artifact' : selected.title}
        onClick={() => setOpen((v) => !v)}
        className={clsx(
          // `overflow-hidden` on the BUTTON, not on the relative wrapper: the
          // wrapper anchors the dropdown, and clipping there would cut the
          // popup off. Without it the glyph and chevron (both `shrink-0`)
          // spill out of a title box that a narrow pane has squeezed to zero,
          // and paint on top of the tabs.
          'flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden rounded-md px-1 py-0.5 text-left transition-colors',
          multiple && 'hover:bg-bg-secondary',
        )}
      >
        <span className="shrink-0 text-base leading-none">{artifactGlyph(selected.type)}</span>
        <span className="min-w-0 truncate text-lg font-semibold">{selected.title}</span>
        {multiple && <ChevronDownIcon size={11} className="text-text-tertiary shrink-0" />}
      </button>
      {open && (
        <PopupMenu
          onClose={() => setOpen(false)}
          triggerRef={triggerRef}
          fitViewport
          className="absolute left-0 top-full mt-1 w-80 py-1"
        >
          {list.map((artifact) => (
            <MenuRow
              key={artifact.id}
              active={artifact.id === selected.id}
              onClick={() => {
                onSelect(artifact.id)
                setOpen(false)
              }}
            >
              {/*
               * Title truncates and the meta is a sibling, not MenuRow's
               * `trailing` overlay: `v3 · 1m ago` is far wider than the 36px
               * that overlay reserves, so it used to sit on top of a title
               * that had already wrapped to two lines.
               */}
              <span className="shrink-0 text-base leading-none">
                {artifactGlyph(artifact.type)}
              </span>
              <span className="min-w-0 flex-1 truncate">{artifact.title}</span>
              <span className="text-text-tertiary shrink-0 text-sm">
                v{artifact.versions.length} · {relativeTimeShort(artifact.updatedAt)}
              </span>
            </MenuRow>
          ))}
        </PopupMenu>
      )}
    </div>
  )
}

function ArtifactPreview({
  artifact,
  content,
}: {
  artifact: Artifact
  content: string
}): React.JSX.Element {
  switch (artifact.type) {
    case 'html':
      return (
        <SandboxedHtml
          html={content}
          title={artifact.title}
          className="bg-bg h-full min-h-[400px] w-full"
        />
      )
    case 'svg':
      return (
        <iframe
          sandbox=""
          srcDoc={`<!doctype html><style>html,body{margin:0;display:grid;place-items:center;height:100%;background:#fff}</style>${content}`}
          title={artifact.title}
          className="h-full min-h-[400px] w-full bg-white"
        />
      )
    case 'mermaid':
      return (
        <div className="p-3">
          <MermaidBlock code={content} />
        </div>
      )
    case 'chart':
      return (
        <div className="p-3">
          <ChartBlock code={content} />
        </div>
      )
    case 'markdown':
      return (
        <div className="p-3">
          <Markdown text={content} />
        </div>
      )
    case 'code':
    default:
      return (
        <div className="[&_.code-block]:my-0 [&_.code-block]:rounded-none [&_.code-block]:border-0">
          <CodeBlock code={content} language={artifactLanguage(artifact)} />
        </div>
      )
  }
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
    <button
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        'rounded-sm px-1.5 py-0.5 text-sm font-medium transition-colors',
        active ? 'bg-bg-secondary text-text' : 'text-text-tertiary hover:text-text',
      )}
    >
      {children}
    </button>
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
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className="text-text-tertiary hover:text-text hover:bg-bg-secondary flex h-6 w-6 shrink-0 items-center justify-center rounded-sm transition-colors disabled:opacity-50"
    >
      {children}
    </button>
  )
}
