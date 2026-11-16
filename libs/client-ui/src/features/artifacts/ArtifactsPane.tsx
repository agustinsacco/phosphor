import { usePlatform } from '@/platform/Platform'
import { localMachineLabel } from '@/lib/localMachine'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { LOCAL_ARTIFACT_PREFIX, useArtifactsStore, type Artifact } from '@/stores/artifacts'
import { useOpenArtifactInFiles } from './openArtifactInFiles'
import { PaneShell, PaneTitle } from '@/components/PaneShell'
import { PageShell } from '@/components/PageShell'
import { CodeBlock } from '@/components/markdown/CodeBlock'
import { MonacoDiff } from '@/features/files/MonacoEditor'
import { useChatStore } from '@/stores/chat'
import { artifactReference } from './artifactReference'
import { FindBar } from '@/components/search/FindBar'
import { useFind } from '@/components/search/useFind'
import { useDomFind } from '@/components/search/useDomFind'
import { useFindTarget } from '@/components/search/findTargets'
import { useSettingsStore } from '@/stores/settings'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { ipcErrorText } from '@shared/errors'
import { saveActionLabel, saveToDevice } from '@/lib/saveToDevice'
import { artifactLanguage, suggestedFileName } from './artifactKinds'
import {
  needsRenderedPreview,
  previewReadySelector,
  printableHtml,
  serializePreview,
  waitForPreview,
} from './previewHtml'

import { ArtifactToolbar, type ViewMode } from './ArtifactToolbar'
import { ArtifactSwitcher, ArtifactPreview } from './ArtifactPresentation'
import { ResponsiveDiff } from '@/components/ResponsiveDiff'

/**
 * Whether a view's text is in this document, where find can reach it. HTML and
 * SVG previews are sandboxed iframes (no script, no shared origin), a chart is
 * pixels on a canvas, and the diff is Monaco with its own ⌘F, so find reads the
 * source view instead.
 */
function findableView(mode: ViewMode, type: Artifact['type']): boolean {
  if (mode === 'diff') return false
  return mode === 'code' || (type !== 'html' && type !== 'svg' && type !== 'chart')
}

/** Right-pane Artifacts region: gallery + versioned viewer. */
export const ArtifactsPane = memo(function ArtifactsPane({
  workspacePath,
  sessionId,
}: {
  workspacePath: string
  sessionId: string
}): React.JSX.Element {
  const artifacts = useArtifactsStore((s) => s.bySession[sessionId])
  const selectedId = useArtifactsStore((s) => s.selected[sessionId])
  const requestedVersion = useArtifactsStore((s) => s.selectedVersion[sessionId])
  const piSessionId = useChatStore((s) => s.sessions[sessionId]?.meta?.sessionId)

  useEffect(() => {
    useArtifactsStore.getState().clearUnseen(sessionId)
  }, [sessionId, artifacts])

  const list = useMemo(
    () => Object.values(artifacts ?? {}).sort((a, b) => b.updatedAt - a.updatedAt),
    [artifacts],
  )
  const selected = (selectedId && artifacts?.[selectedId]) || list[0]

  if (!selected) {
    return (
      <PaneShell title={<PaneTitle label="Artifacts" />}>
        <div className="flex h-full items-center justify-center px-6">
          <div className="text-center">
            <div className="text-text-tertiary text-lg">No artifacts yet</div>
            <div className="text-text-tertiary mt-1 text-sm">
              Ask for a document, plan or prototype. Artifacts stay here with version history.
            </div>
          </div>
        </div>
      </PaneShell>
    )
  }

  return (
    <ArtifactWorkspace
      key={`${sessionId}:${selected.id}`}
      artifact={selected}
      list={list}
      workspacePath={workspacePath}
      sessionId={sessionId}
      piSessionId={piSessionId}
      onSelect={(id) => useArtifactsStore.getState().select(sessionId, id)}
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
export function ArtifactWorkspace({
  artifact,
  list,
  workspacePath,
  sessionId,
  piSessionId,
  onSelect,
  requestedVersion,
  page,
  remote = workspacePath.startsWith('host:'),
}: {
  artifact: Artifact
  list: Artifact[]
  workspacePath: string
  /** The lane whose Files pane a written artifact opens in. */
  sessionId?: string
  /** pi's id for the session that owns the artifact; names it in a copied reference. */
  piSessionId?: string
  onSelect: (id: string) => void
  /** Version explicitly navigated to (e.g. a chat card's "Open in panel"). */
  requestedVersion?: number
  /**
   * Render on a global page instead of in the right pane: the page's chrome
   * (no pane side, fullscreen or close), `leading` before the title, and no
   * "write into workspace", since there is no live workspace to open it in.
   */
  page?: { leading: React.ReactNode }
  remote?: boolean
}): React.JSX.Element {
  const Shell = page ? PageArtifactShell : PaneShell
  const latest = artifact.versions[artifact.versions.length - 1]!
  const platform = usePlatform()
  // A Host artifact downloads to this machine, so its actions name it.
  const here = remote ? localMachineLabel() : null
  const downloads = here ? `${here} Downloads` : 'Downloads'
  const saveTitle = saveActionLabel('source', platform.nativeFiles, here ?? 'file')
  const writeIn = useOpenArtifactInFiles(workspacePath, sessionId)
  const [mode, setMode] = useState<ViewMode>('preview')
  const [exporting, setExporting] = useState(false)
  // The PDF prints the rendered preview, so the export reads this node for the
  // types React draws — and the staged document carries the app's theme, the
  // same way the preview iframe does.
  const previewRef = useRef<HTMLDivElement>(null)
  const theme = useSettingsStore((s) => s.resolvedTheme)
  const paneRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const find = useFind()
  const searchable = findableView(mode, artifact.type)
  const matches = useDomFind({ find, rootRef: scrollRef, enabled: searchable })
  const { show } = find
  useFindTarget(paneRef, (seed) => {
    if (!findableView(mode, artifact.type)) setMode('code')
    show(seed)
  })
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

  // The current version is named without a number, so a prompt reads whatever
  // is newest; an older one being read is pinned.
  // A promoted code block lives only in this pane, so pi has nothing to read.
  const promoted = artifact.id.startsWith(LOCAL_ARTIFACT_PREFIX)
  const reference = promoted
    ? null
    : artifactReference(
        piSessionId,
        artifact.id,
        shown.version === latest.version ? undefined : shown.version,
      )
  const copyReference = (): void => {
    if (!reference) return
    void navigator.clipboard.writeText(reference).then(
      () =>
        useExtensionUiStore
          .getState()
          .pushToast(`Copied ${reference} — paste it into a prompt to point the agent at it`),
      (error) => useExtensionUiStore.getState().pushToast(ipcErrorText(error), 'error'),
    )
  }

  const save = (): Promise<void> =>
    saveToDevice(
      { title: 'Save artifact', name: suggestedFileName(artifact), content: () => shown.content },
      platform.nativeFiles,
    )

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
    <Shell
      rootRef={paneRef}
      title={
        <>
          {page?.leading}
          <ArtifactSwitcher list={list} selected={artifact} onSelect={onSelect} />
        </>
      }
      actions={
        <ArtifactToolbar
          artifact={artifact}
          shown={shown}
          mode={mode}
          setMode={setMode}
          selectVersion={(version) => {
            const index = artifact.versions.findIndex((v) => v.version === version)
            if (index !== -1) setVersionIndex(index)
          }}
          reference={reference}
          promoted={promoted}
          copyReference={copyReference}
          saveTitle={saveTitle}
          save={save}
          exporting={exporting}
          downloads={downloads}
          exportPdf={exportPdf}
          canWrite={!page && (platform.fileEditing || remote)}
          writeIn={writeIn}
          write={() => void writeIn.open(artifact, shown.content)}
        />
      }
    >
      <div className="relative flex min-h-0 flex-1 flex-col">
        <FindBar
          find={find}
          total={matches.total}
          active={matches.active}
          capped={matches.capped}
          onStep={matches.step}
          placeholder="Find in artifact"
          unavailable={
            searchable
              ? undefined
              : {
                  reason: `The ${mode === 'diff' ? 'diff' : 'preview'} cannot be searched here — its source can`,
                  action: 'Switch to Code',
                  onAction: () => {
                    setMode('code')
                    // The button unmounts with the switch; the field takes focus back.
                    show()
                  },
                }
          }
          testId="artifact-find"
        />
        {/* Focusable (not tabbable) so a click inside puts ⌘F here, not in the transcript. */}
        <div
          ref={scrollRef}
          tabIndex={-1}
          className="min-h-0 flex-1 overflow-y-auto outline-none"
          data-testid="artifact-scroll"
        >
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
              <ResponsiveDiff
                original={previous?.content ?? ''}
                modified={shown.content}
                editor={
                  <MonacoDiff
                    originalText={previous?.content ?? ''}
                    modifiedText={shown.content}
                    language={artifactLanguage(artifact)}
                    renderSideBySide={false}
                  />
                }
              />
            </div>
          )}
        </div>
      </div>
    </Shell>
  )
}

/** PageShell with PaneShell's props, so one viewer serves the pane and a page. */
function PageArtifactShell({
  rootRef,
  ...shell
}: React.ComponentProps<typeof PageShell> & {
  rootRef?: React.Ref<HTMLDivElement>
}): React.JSX.Element {
  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
      <PageShell {...shell} />
    </div>
  )
}
