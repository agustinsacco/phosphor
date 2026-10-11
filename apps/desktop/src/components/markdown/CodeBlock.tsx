import { memo, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { highlightCode } from './highlighter'
import { CopyButton } from '../CopyButton'
import { ArtifactsIcon } from '../icons'
import { runInTerminal } from '@/stores/terminal'
import { getActiveWorkspace } from '@/stores/workspaces'

const SHELL_LANGUAGES = new Set(['bash', 'sh', 'shell', 'zsh', 'console', 'terminal', 'fish'])

function artifactTypeForLanguage(
  language: string,
): 'html' | 'svg' | 'mermaid' | 'chart' | 'markdown' | 'code' {
  switch (language.toLowerCase()) {
    case 'html':
      return 'html'
    case 'svg':
      return 'svg'
    case 'mermaid':
      return 'mermaid'
    case 'chart':
    case 'vega-lite':
      return 'chart'
    case 'markdown':
    case 'md':
      return 'markdown'
    default:
      return 'code'
  }
}

async function promoteToArtifact(code: string, language: string): Promise<void> {
  const [{ useArtifactsStore }, { useSessionsStore }] = await Promise.all([
    import('@/stores/artifacts'),
    import('@/stores/sessions'),
  ])
  const sessionId = useSessionsStore.getState().activeSessionId
  if (!sessionId) return
  const type = artifactTypeForLanguage(language)
  useArtifactsStore.getState().addLocal(sessionId, {
    title: `${language || 'code'} snippet`,
    type,
    language: type === 'code' ? language || undefined : undefined,
    content: code,
  })
}

interface CodeBlockProps {
  code: string
  language: string
  /** While the fence is still open we show plain mono (no flicker). */
  streaming?: boolean
  actions?: React.ReactNode
}

export const CodeBlock = memo(function CodeBlock({
  code,
  language,
  streaming = false,
  actions,
}: CodeBlockProps): React.JSX.Element {
  const [html, setHtml] = useState<string | null>(null)
  const requestRef = useRef(0)

  useEffect(() => {
    if (streaming || !language || ['text', 'plaintext', 'txt'].includes(language.toLowerCase())) {
      setHtml(null)
      return
    }
    const request = ++requestRef.current
    let cancelled = false
    void highlightCode(code, language).then(
      (result) => {
        if (!cancelled && request === requestRef.current) setHtml(result)
      },
      () => {
        // A missing grammar or unavailable engine must leave safe plaintext,
        // not an unhandled rejection (Electron's CSP can refuse WASM).
        if (!cancelled && request === requestRef.current) setHtml(null)
      },
    )
    return () => {
      cancelled = true
    }
  }, [code, language, streaming])

  return (
    <div className="code-block border-border bg-code-bg group/code relative my-3 overflow-hidden rounded-lg border">
      <div
        data-find-skip
        className="border-border text-text-tertiary flex h-8 items-center justify-between border-b px-3"
      >
        <span className="font-mono text-sm font-mono uppercase tracking-wide">
          {language || 'text'}
        </span>
        <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover/code:opacity-100">
          {actions}
          <button
            title="Open as artifact"
            onClick={() => void promoteToArtifact(code, language)}
            className="text-text-tertiary hover:text-text hover:bg-bg-secondary flex h-6 items-center gap-1 rounded-md px-1.5 text-sm transition-colors"
          >
            <ArtifactsIcon size={12} />
          </button>
          {SHELL_LANGUAGES.has(language.toLowerCase()) && (
            <button
              title="Run in terminal (pastes, doesn't execute)"
              onClick={() => {
                const workspacePath = getActiveWorkspace()
                if (workspacePath) void runInTerminal(workspacePath, code)
              }}
              className="text-text-tertiary hover:text-text hover:bg-bg-secondary flex h-6 items-center gap-1 rounded-md px-1.5 text-sm transition-colors"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="m5 7 5 5-5 5M13 17h6" />
              </svg>
            </button>
          )}
          <CopyButton text={code} />
        </div>
      </div>
      <div className="overflow-x-auto">
        {html && !streaming ? (
          <div
            className="shiki-container px-4 py-3 font-mono text-base leading-relaxed"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <pre className="m-0 px-4 py-3 font-mono text-base leading-relaxed whitespace-pre">
            {code}
          </pre>
        )}
      </div>
    </div>
  )
})

interface InlineCodeProps {
  children: React.ReactNode
  className?: string
}

export function InlineCode({ children, className }: InlineCodeProps): React.JSX.Element {
  return (
    <code
      className={clsx(
        'bg-code-bg border-border rounded-[5px] border px-[5px] py-[1.5px] font-mono text-[0.86em]',
        className,
      )}
    >
      {children}
    </code>
  )
}
