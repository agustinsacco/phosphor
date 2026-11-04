import type { PreviewKind } from '@shared/file-kinds'
import { MarkdownPreview } from './MarkdownPreview'
import { SandboxedHtml } from '@/components/SandboxedHtml'
import { printableHtml } from '@/features/artifacts/previewHtml'
import { basename } from '@/lib/path'

/**
 * A text file drawn from its content. A Host file has no `phosphor-file://` grant, so HTML and
 * SVG go through the artifact sandbox; an SVG is centred the way an SVG artifact is.
 */
export default function TextFileRender({
  kind,
  path,
  content,
}: {
  kind: PreviewKind
  path: string
  content: string
}): React.JSX.Element {
  if (kind === 'markdown') return <MarkdownPreview text={content} />
  return (
    <SandboxedHtml
      html={kind === 'html' ? content : printableHtml('svg', content)}
      title={basename(path)}
      className="bg-bg block h-full w-full border-0"
    />
  )
}
