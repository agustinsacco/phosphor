import { CodeBlock } from '@/components/markdown/CodeBlock'
import { MonacoEditor } from './MonacoEditor'
import { languageForPath } from '@/lib/monaco'

/** The caller arranges it (`ListDetail`); platform capabilities choose the preview implementation. */
export function RepositoryFilePreview({
  back,
  nativeEditor,
  path,
  resourcePath,
  preview,
  reading,
  binary,
}: {
  /** The way back to the file list, where the layout gives one. */
  back?: React.ReactNode
  nativeEditor: boolean
  path: string
  resourcePath: string
  preview: string
  reading: boolean
  binary: boolean
}): React.JSX.Element {
  if (!nativeEditor && path)
    return (
      <div className="h-full overflow-auto">
        {back}
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
