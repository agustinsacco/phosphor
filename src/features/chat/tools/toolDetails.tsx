import { useState } from 'react'
import clsx from 'clsx'
import type { ToolState } from '../reducer'
import {
  editDiffStats,
  toolDetails,
  toolText,
  tryParseArgs,
  type EditDetails,
} from './toolSummaries'
import { formatBytes, formatDuration } from '@/lib/format'
import { DiffView } from './DiffView'
import { CodeBlock } from '@/components/markdown/CodeBlock'
import { CopyButton } from '@/components/CopyButton'
import { Lightbox } from '@/components/Lightbox'
import { PathLink } from './PathLink'
import { ChevronIcon } from '@/components/icons'
import type { DiffStats } from '../diff'

/** Per-tool expanded detail views, dispatched from ToolCard by tool name. */

/**
 * "+3 −1" counters. Zero halves are omitted — "+148 −0" on a created file is
 * noise. Both zero renders nothing at all.
 */
export function DiffStatBadges({
  stats,
  className,
}: {
  stats: DiffStats
  className?: string
}): React.JSX.Element | null {
  if (stats.additions === 0 && stats.deletions === 0) return null
  return (
    <span className={clsx('shrink-0 font-mono', className)}>
      {stats.additions > 0 && <span className="text-success">+{stats.additions}</span>}
      {stats.additions > 0 && stats.deletions > 0 && ' '}
      {stats.deletions > 0 && <span className="text-danger">−{stats.deletions}</span>}
    </span>
  )
}

export function BashDetail({ tool }: { tool: ToolState }): React.JSX.Element {
  const command = typeof tool.args?.command === 'string' ? tool.args.command : tool.argsText
  const output = toolText(tool)
  const details = toolDetails<{
    fullOutputPath?: string | null
    truncation?: { truncated?: boolean } | null
  }>(tool)
  const running = tool.status === 'starting' || tool.status === 'running'
  const durationMs = tool.startedAt && tool.endedAt ? tool.endedAt - tool.startedAt : null

  return (
    <div>
      <div className="border-border flex items-center justify-between gap-2 border-b px-3 py-2">
        <code className="text-text flex-1 truncate font-mono text-base">$ {command}</code>
        <div className="flex shrink-0 items-center gap-2">
          {durationMs !== null && (
            <span className="text-text-tertiary text-sm">{formatDuration(durationMs)}</span>
          )}
          {running ? (
            <span className="text-text-tertiary text-sm">running…</span>
          ) : (
            <span
              className={clsx(
                'rounded px-1.5 py-px font-mono text-xs font-medium',
                tool.isError ? 'bg-danger-soft text-danger' : 'bg-success/15 text-success',
              )}
            >
              {tool.isError ? 'error' : 'exit 0'}
            </span>
          )}
          <CopyButton text={output} />
        </div>
      </div>
      <pre className="terminal-output max-h-80 overflow-auto px-3 py-2.5 font-mono text-base leading-relaxed break-words whitespace-pre-wrap">
        {output || (running ? '…' : '(no output)')}
      </pre>
      {details?.fullOutputPath && (
        <div className="border-border text-text-tertiary border-t px-3 py-1.5 text-sm">
          Output truncated — full log at <code className="font-mono">{details.fullOutputPath}</code>
        </div>
      )}
    </div>
  )
}

export function EditDetail({ tool }: { tool: ToolState }): React.JSX.Element {
  const details = toolDetails<EditDetails>(tool)
  const path = typeof tool.args?.path === 'string' ? tool.args.path : ''
  const stats = editDiffStats(tool)

  return (
    <div>
      <div className="border-border flex items-center justify-between gap-2 border-b px-3 py-2">
        <PathLink path={path} line={details?.firstChangedLine} />
        {stats && <DiffStatBadges stats={stats} className="text-sm" />}
      </div>
      {details?.diff ? (
        <DiffView diff={details.diff} />
      ) : tool.isError ? (
        <ErrorText text={toolText(tool)} />
      ) : (
        <div className="text-text-tertiary px-3 py-2 text-base">Waiting for diff…</div>
      )}
    </div>
  )
}

export function WriteDetail({ tool }: { tool: ToolState }): React.JSX.Element {
  const path = typeof tool.args?.path === 'string' ? tool.args.path : ''
  const content = typeof tool.args?.content === 'string' ? tool.args.content : ''
  const language = path.split('.').pop() ?? 'text'

  if (tool.isError) return <ErrorText text={toolText(tool)} />
  return (
    <div className="[&_.code-block]:my-0 [&_.code-block]:rounded-none [&_.code-block]:border-0">
      <div className="border-border flex items-center justify-between border-b px-3 py-2">
        <PathLink path={path} />
      </div>
      <div className="max-h-80 overflow-auto">
        <CodeBlock code={content} language={language} />
      </div>
    </div>
  )
}

export function ReadDetail({ tool }: { tool: ToolState }): React.JSX.Element {
  const path = typeof tool.args?.path === 'string' ? tool.args.path : ''
  const offset = typeof tool.args?.offset === 'number' ? tool.args.offset : undefined
  const limit = typeof tool.args?.limit === 'number' ? tool.args.limit : undefined
  const content = tool.result?.content ?? tool.output?.content ?? []
  const text = toolText(tool)
  const images = content.filter((b) => b.type === 'image')

  if (tool.isError) return <ErrorText text={text} />
  return (
    <div>
      <div className="border-border flex items-center justify-between gap-2 border-b px-3 py-2">
        <span className="flex min-w-0 items-baseline gap-0.5">
          <PathLink path={path} line={offset} />
          {offset != null && (
            <span className="text-text-tertiary font-mono text-base">
              :{offset}
              {limit != null ? `–${offset + limit}` : ''}
            </span>
          )}
        </span>
        <CopyButton text={text} />
      </div>
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 p-3">
          {images.map((img, i) =>
            img.type === 'image' ? (
              <ZoomableImage key={i} data={img.data} mimeType={img.mimeType} />
            ) : null,
          )}
        </div>
      )}
      {text && (
        <pre className="max-h-80 overflow-auto px-3 py-2.5 font-mono text-base leading-relaxed break-words whitespace-pre-wrap">
          {text}
        </pre>
      )}
    </div>
  )
}

export function ListDetail({ tool }: { tool: ToolState }): React.JSX.Element {
  const text = toolText(tool)
  const details = toolDetails<{
    matchLimitReached?: number
    resultLimitReached?: number
    entryLimitReached?: number
  }>(tool)
  const limit =
    details?.matchLimitReached ?? details?.resultLimitReached ?? details?.entryLimitReached

  if (tool.isError) return <ErrorText text={text} />
  return (
    <div>
      <pre className="max-h-80 overflow-auto px-3 py-2.5 font-mono text-base leading-relaxed break-words whitespace-pre-wrap">
        {text || '(no results)'}
      </pre>
      {limit != null && (
        <div className="border-border text-text-tertiary border-t px-3 py-1.5 text-sm">
          Result limit reached ({limit}) — output truncated
        </div>
      )}
    </div>
  )
}

/** Unknown/extension tools: name, pretty args, streaming output, error state. */
export function GenericDetail({ tool }: { tool: ToolState }): React.JSX.Element {
  const [argsExpanded, setArgsExpanded] = useState(false)
  const args = tool.args ?? tryParseArgs(tool.argsText)
  const argsJson = args ? JSON.stringify(args, null, 2) : tool.argsText
  const text = toolText(tool)
  const images = (tool.result?.content ?? tool.output?.content ?? []).filter(
    (b) => b.type === 'image',
  )
  const running = tool.status === 'starting' || tool.status === 'running'

  return (
    <div>
      <div className="border-border border-b px-3 py-2">
        <button
          onClick={() => setArgsExpanded((e) => !e)}
          className="text-text-tertiary hover:text-text flex items-center gap-1 text-sm transition-colors"
        >
          <ChevronIcon expanded={argsExpanded} className="text-text-tertiary" />
          {tool.toolName && <span className="font-mono">{tool.toolName}</span>}
          <span>arguments</span>
          {!tool.toolName && tool.argsText && (
            <span className="text-text-tertiary">· {formatBytes(tool.argsText.length)} so far</span>
          )}
        </button>
        {argsExpanded && (
          <pre className="bg-code-bg border-border mt-2 max-h-60 overflow-auto rounded-md border px-2.5 py-2 font-mono text-sm leading-relaxed break-words whitespace-pre-wrap">
            {argsJson || '(none)'}
          </pre>
        )}
      </div>
      {tool.isError ? (
        <ErrorText text={text} />
      ) : (
        <>
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2 p-3">
              {images.map((img, i) =>
                img.type === 'image' ? (
                  <ZoomableImage key={i} data={img.data} mimeType={img.mimeType} />
                ) : null,
              )}
            </div>
          )}
          <pre className="max-h-80 overflow-auto px-3 py-2.5 font-mono text-base leading-relaxed break-words whitespace-pre-wrap">
            {text || (running ? 'Running…' : '(no output)')}
          </pre>
        </>
      )}
    </div>
  )
}

// ---------- shared bits ----------

export function ErrorText({ text }: { text: string }): React.JSX.Element {
  return (
    <pre className="text-danger max-h-80 overflow-auto px-3 py-2.5 font-mono text-base leading-relaxed break-words whitespace-pre-wrap">
      {text || 'Tool failed'}
    </pre>
  )
}

export function ZoomableImage({
  data,
  mimeType,
}: {
  data: string
  mimeType: string
}): React.JSX.Element {
  const [zoomed, setZoomed] = useState(false)
  const src = `data:${mimeType};base64,${data}`
  return (
    <>
      <img
        src={src}
        className="max-h-64 cursor-zoom-in rounded-md"
        onClick={() => setZoomed(true)}
      />
      {zoomed && (
        <Lightbox onClose={() => setZoomed(false)}>
          <img src={src} className="max-h-[90vh] max-w-[90vw] rounded-lg" />
        </Lightbox>
      )}
    </>
  )
}
