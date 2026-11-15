import { useRef } from 'react'
import { CodeBlock } from '@/components/markdown/CodeBlock'
import { FileTextEditing } from '@/components/FileTextEditing'
import { useFilesStore, type OpenFile, type PendingReveal } from '@/stores/files'
import { MonacoEditor } from './MonacoEditor'
import { runFileAction } from './fileActions'
import { useLineReveal } from './useLineReveal'

/** The open file's text: Monaco, or where Monaco cannot run its highlighted text and a plain field. */
export function ActiveEditor({
  file,
  workspacePath,
  readOnly,
}: {
  file: OpenFile
  workspacePath: string
  readOnly: boolean
}): React.JSX.Element {
  const onChange = (value: string) =>
    useFilesStore.getState().updateBuffer(workspacePath, file.path, value)
  const onSave = () => runFileAction(useFilesStore.getState().saveFile(workspacePath, file.path))
  return (
    <FileTextEditing
      id={file.path}
      label={`Edit ${file.relativePath}`}
      value={file.content}
      dirty={file.dirty}
      readOnly={readOnly}
      onChange={onChange}
      onSave={onSave}
      reader={
        <CodeReadView content={file.content} language={file.language} reveal={file.pendingReveal} />
      }
      editor={
        <MonacoEditor
          path={file.path}
          language={file.language}
          value={file.content}
          readOnly={readOnly}
          reveal={file.pendingReveal}
          onChange={onChange}
          onSave={onSave}
        />
      }
    />
  )
}

/** Text in its language, scrolled to the line a chat link names, without a chat block's actions. */
function CodeReadView({
  content,
  language,
  reveal,
}: {
  content: string
  language: string
  reveal?: PendingReveal
}): React.JSX.Element {
  const scroller = useRef<HTMLDivElement>(null)
  useLineReveal(scroller, reveal, content)
  return (
    <div ref={scroller} className="h-full overflow-auto p-3">
      <CodeBlock code={content} language={language} chatActions={false} />
    </div>
  )
}
