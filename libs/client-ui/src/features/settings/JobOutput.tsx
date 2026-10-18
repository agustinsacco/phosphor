import { useEffect, useRef } from 'react'
import clsx from 'clsx'

/**
 * Streamed output of the running (or last) package job — the render half of
 * `usePackageJob`, which is why it lives beside it rather than inside the one
 * tab that happened to need it first.
 */
export function JobOutput({
  running,
  output,
  exitCode,
}: {
  running: boolean
  output: string
  exitCode: number | null
}): React.JSX.Element | null {
  const preRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    preRef.current?.scrollTo({ top: preRef.current.scrollHeight })
  }, [output])

  if (!running && !output) return null
  return (
    <div className="mt-3">
      <div className="flex items-center gap-2">
        <span
          className={clsx(
            'h-1.5 w-1.5 rounded-full',
            running ? 'bg-warning animate-pulse' : exitCode === 0 ? 'bg-success' : 'bg-danger',
          )}
        />
        <span className="text-text-tertiary text-sm">
          {running ? 'Running…' : exitCode === 0 ? 'Done' : `Failed (exit ${exitCode})`}
        </span>
      </div>
      <pre
        ref={preRef}
        className="bg-code-bg border-border mt-1.5 max-h-48 overflow-auto rounded-md border px-3 py-2 font-mono text-sm leading-relaxed whitespace-pre-wrap"
      >
        {output || '…'}
      </pre>
    </div>
  )
}
