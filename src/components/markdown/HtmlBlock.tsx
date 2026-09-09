import { memo, useState } from 'react'
import { SandboxedHtml } from '@/components/SandboxedHtml'
import clsx from 'clsx'
import { CodeBlock } from './CodeBlock'

/**
 * ```html blocks — Code/Preview toggle. Preview renders in a sandboxed
 * iframe: scripts allowed for interactivity, but no same-origin access, no
 * network beyond inline content, no top-navigation.
 */
export const HtmlBlock = memo(function HtmlBlock({ code }: { code: string }): React.JSX.Element {
  const [mode, setMode] = useState<'preview' | 'code'>('preview')

  return (
    <div className="border-border my-3 overflow-hidden rounded-lg border">
      <div className="border-border bg-surface flex h-9 items-center gap-1 border-b px-2">
        <ToggleTab active={mode === 'preview'} onClick={() => setMode('preview')}>
          Preview
        </ToggleTab>
        <ToggleTab active={mode === 'code'} onClick={() => setMode('code')}>
          Code
        </ToggleTab>
      </div>
      {mode === 'preview' ? (
        <SandboxedHtml html={code} title="HTML preview" className="bg-bg h-96 w-full" />
      ) : (
        <div className="[&>div]:my-0 [&>div]:rounded-none [&>div]:border-0">
          <CodeBlock code={code} language="html" />
        </div>
      )}
    </div>
  )
})

function ToggleTab({
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
      className={clsx(
        'rounded-md px-2.5 py-1 text-base font-medium transition-colors',
        active ? 'bg-bg-secondary text-text' : 'text-text-tertiary hover:text-text',
      )}
    >
      {children}
    </button>
  )
}
