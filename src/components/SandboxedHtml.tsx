import { useEffect, useState } from 'react'

/**
 * Model-authored HTML, rendered so it can actually run.
 *
 * The obvious implementation — `<iframe sandbox="allow-scripts" srcDoc={html}>`
 * — silently does not work. A `srcdoc` document inherits the embedder's policy
 * container, so `script-src 'self'` from `src/index.html` refuses every inline
 * script and the sandbox attribute is a no-op. That is not a theory: an
 * interactive artifact rendered as a page of empty boxes where its scripted
 * regions should have been, and Chromium logged the refusal.
 *
 * So the HTML is staged in the main process and served over `phosphor-artifact://`
 * with its own `default-src 'none'` policy. The sandbox attribute stays and
 * deliberately omits `allow-same-origin`, which keeps the document's origin
 * opaque. See electron/artifacts/artifact-protocol.ts for the measured
 * containment table.
 */
export function SandboxedHtml({
  html,
  title,
  className,
}: {
  html: string
  title: string
  className?: string
}): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setFailed(false)
    void window.phosphor
      .invoke('artifacts:stageHtml', html)
      .then((staged) => {
        if (!cancelled) setUrl(staged)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [html])

  // Staging is a single synchronous main-process map write, so this is a frame
  // or two — a spinner here would flash rather than inform.
  if (failed) {
    return (
      <div className="text-text-tertiary flex h-full min-h-[400px] items-center justify-center p-6 text-center text-sm">
        Could not prepare this HTML for preview.
      </div>
    )
  }
  if (!url) return <div className={className ?? 'h-full min-h-[400px] w-full'} />

  return (
    <iframe
      // No `allow-same-origin`: that is what keeps the origin opaque, and with
      // it the document could reach this app's storage. Never add it.
      sandbox="allow-scripts"
      src={url}
      title={title}
      className={className ?? 'h-full min-h-[400px] w-full bg-white'}
    />
  )
}
