import { useRef, useState } from 'react'
import clsx from 'clsx'
import { usePlatform } from '@/platform/Platform'
import { TooltipButton } from '@/components/Tooltip'
import { PopupMenu, MenuRow } from '@/components/PopupMenu'
import { ChevronDownIcon } from '@/components/icons'
import { Markdown } from '@/components/markdown/Markdown'
import { CodeBlock } from '@/components/markdown/CodeBlock'
import { MermaidBlock } from '@/components/markdown/MermaidBlock'
import { ChartBlock } from '@/components/markdown/ChartBlock'
import { SandboxedHtml } from '@/components/SandboxedHtml'
import { relativeTimeShort } from '@/lib/time'
import type { Artifact } from '@/stores/artifacts'
import { artifactGlyph, artifactLanguage } from './artifactKinds'

/**
 * Header title = the selected artifact itself (glyph, name). With more than
 * one artifact it becomes a dropdown switcher; with one it is a plain label.
 *
 * No timestamp here: it cost ~45px of a row that also carries the tabs, the
 * version picker and the shell's buttons, and the dropdown already dates every
 * artifact.
 */
export function ArtifactSwitcher({
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
      <TooltipButton
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
      </TooltipButton>
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

export function ArtifactPreview({
  artifact,
  content,
}: {
  artifact: Artifact
  content: string
}): React.JSX.Element {
  const platform = usePlatform()
  if (!platform.scriptedArtifacts && (artifact.type === 'html' || artifact.type === 'svg'))
    return (
      <div className="flex h-full flex-col">
        <p className="text-text-tertiary p-2 text-sm">
          Static preview · scripts and network access are disabled.
        </p>
        <SandboxedHtml
          html={content}
          title={artifact.title}
          className="bg-bg min-h-0 w-full flex-1 border-0"
        />
      </div>
    )
  switch (artifact.type) {
    case 'html':
      return (
        <SandboxedHtml
          html={content}
          title={artifact.title}
          className="bg-bg block h-full w-full border-0"
        />
      )
    case 'svg':
      return (
        <iframe
          sandbox=""
          srcDoc={`<!doctype html><style>html,body{margin:0;display:grid;place-items:center;height:100%;background:#fff}</style>${content}`}
          data-tooltip={artifact.title}
          className="block h-full w-full border-0 bg-white"
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
        <div className="mx-auto min-w-0 max-w-[76ch] p-4 sm:p-6">
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
