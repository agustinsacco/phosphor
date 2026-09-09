import { memo, useMemo, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { CodeBlock, InlineCode } from './CodeBlock'
import { MermaidBlock } from './MermaidBlock'
import { ChartBlock } from './ChartBlock'
import { VegaLiteBlock } from './VegaLiteBlock'
import { HtmlBlock } from './HtmlBlock'
import { Lightbox } from '../Lightbox'
import { MarkdownLink } from './MarkdownLink'
import { artifactUrlTransform } from '@/lib/markdownLink'
import { remarkArtifactLinks } from '@/lib/remarkArtifactLinks'

// remarkArtifactLinks runs last: GFM's own autolinking has already claimed the
// www/http text it wants, so what is left to promote is only ours.
const REMARK_PLUGINS = [remarkGfm, remarkMath, remarkArtifactLinks]
const REHYPE_PLUGINS = [rehypeKatex]

/**
 * Split streaming text at a trailing unclosed fence so the open fence renders
 * as plain mono until it closes (no rich-render flicker).
 */
function splitOpenFence(text: string): { closed: string; openFence: string | null } {
  const fenceMatches = [...text.matchAll(/^(```|~~~)/gm)]
  if (fenceMatches.length % 2 === 0) return { closed: text, openFence: null }
  const last = fenceMatches[fenceMatches.length - 1]!
  return { closed: text.slice(0, last.index), openFence: text.slice(last.index) }
}

function MarkdownImage(props: React.ImgHTMLAttributes<HTMLImageElement>): React.JSX.Element {
  const [zoomed, setZoomed] = useState(false)
  return (
    <>
      <img
        {...props}
        className="my-2 max-h-96 max-w-full cursor-zoom-in rounded-lg"
        onClick={() => setZoomed(true)}
      />
      {zoomed && (
        <Lightbox onClose={() => setZoomed(false)}>
          <img src={props.src} alt={props.alt} className="max-h-[90vh] max-w-[90vw] rounded-lg" />
        </Lightbox>
      )}
    </>
  )
}

function tableToText(table: HTMLTableElement, format: 'markdown' | 'csv'): string {
  const rows = [...table.querySelectorAll('tr')].map((tr) =>
    [...tr.querySelectorAll('th,td')].map((cell) => (cell.textContent ?? '').trim()),
  )
  if (rows.length === 0) return ''
  if (format === 'csv') {
    return rows
      .map((row) =>
        row.map((c) => (/[",\n]/.test(c) ? `"${c.replaceAll('"', '""')}"` : c)).join(','),
      )
      .join('\n')
  }
  const header = rows[0]!
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.slice(1).map((row) => `| ${row.join(' | ')} |`),
  ]
  return lines.join('\n')
}

function MarkdownTable(props: React.TableHTMLAttributes<HTMLTableElement>): React.JSX.Element {
  const [copied, setCopied] = useState<string | null>(null)
  const copy = (event: React.MouseEvent, format: 'markdown' | 'csv'): void => {
    const container = (event.currentTarget as HTMLElement).closest('.md-table-wrap')
    const table = container?.querySelector('table')
    if (!table) return
    void navigator.clipboard.writeText(tableToText(table, format)).then(() => {
      setCopied(format)
      setTimeout(() => setCopied(null), 1400)
    })
  }
  return (
    <div className="md-table-wrap group/table relative my-3">
      <div className="absolute -top-3 right-1 z-10 hidden gap-1 group-hover/table:flex">
        <button
          onClick={(e) => copy(e, 'markdown')}
          className="border-border bg-surface text-text-tertiary hover:text-text rounded-md border px-2 py-0.5 text-xs shadow-sm"
        >
          {copied === 'markdown' ? 'Copied' : 'Copy MD'}
        </button>
        <button
          onClick={(e) => copy(e, 'csv')}
          className="border-border bg-surface text-text-tertiary hover:text-text rounded-md border px-2 py-0.5 text-xs shadow-sm"
        >
          {copied === 'csv' ? 'Copied' : 'Copy CSV'}
        </button>
      </div>
      <div className="border-border overflow-x-auto rounded-lg border">
        <table {...props} className="md-table w-full border-collapse text-lg" />
      </div>
    </div>
  )
}

function CodeRenderer({
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode }): React.JSX.Element {
  const language = /language-(\S+)/.exec(className ?? '')?.[1]
  const code = String(children ?? '').replace(/\n$/, '')

  // No language class and single-line → inline code.
  if (!language && !code.includes('\n')) {
    return <InlineCode className={className}>{children}</InlineCode>
  }

  switch (language) {
    case 'mermaid':
      return <MermaidBlock code={code} />
    case 'chart':
      return <ChartBlock code={code} />
    case 'vega-lite':
      return <VegaLiteBlock code={code} />
    case 'html':
      return <HtmlBlock code={code} />
    default:
      return <CodeBlock code={code} language={language ?? 'text'} {...rest} />
  }
}

const components: Components = {
  code: CodeRenderer,
  // CodeRenderer emits its own containers; unwrap the default <pre>.
  pre: ({ children }) => <>{children}</>,
  img: (props) => <MarkdownImage {...props} />,
  table: (props) => <MarkdownTable {...props} />,
  a: (props) => <MarkdownLink {...props} />,
}

interface MarkdownProps {
  text: string
  streaming?: boolean
}

export const Markdown = memo(function Markdown({
  text,
  streaming = false,
}: MarkdownProps): React.JSX.Element {
  const { closed, openFence } = useMemo(
    () => (streaming ? splitOpenFence(text) : { closed: text, openFence: null }),
    [text, streaming],
  )

  return (
    <div className="md-content">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        urlTransform={artifactUrlTransform}
        components={components}
      >
        {closed}
      </ReactMarkdown>
      {openFence !== null && (
        <pre className="border-border bg-code-bg my-3 overflow-x-auto rounded-lg border px-4 py-3 font-mono text-base leading-relaxed opacity-80">
          {openFence.split('\n').slice(1).join('\n')}
        </pre>
      )}
    </div>
  )
})
