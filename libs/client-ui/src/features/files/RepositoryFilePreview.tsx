import { Button } from '@/components/form'
import { CodeBlock } from '@/components/markdown/CodeBlock'
import { MonacoEditor } from './MonacoEditor'
import { languageForPath } from '@/lib/monaco'

/** Width chooses arrangement; platform capabilities choose the preview implementation. */
export function RepositoryFilePreview({
  compact,
  nativeEditor,
  path,
  resourcePath,
  preview,
  reading,
  binary,
  onBack,
}: {
  compact: boolean
  nativeEditor: boolean
  path: string
  resourcePath: string
  preview: string
  reading: boolean
  binary: boolean
  onBack: () => void
}): React.JSX.Element {
  if (!nativeEditor && path)
    return (
      <div className="h-full overflow-auto">
        {compact && <Button onClick={onBack}>← Files</Button>}
        {reading ? (
          <p role="status">Reading file…</p>
        ) : binary ? (
          <p>{preview}</p>
        ) : (
          <CodeBlock code={preview} language="text" />
        )}
      </div>
    )
  if (path && !binary)
    return (
      <MonacoEditor path={resourcePath} language={languageForPath(path)} value={preview} readOnly />
    )
  return <p className="text-text-tertiary p-4">{path ? preview : 'Select a file to preview'}</p>
}
