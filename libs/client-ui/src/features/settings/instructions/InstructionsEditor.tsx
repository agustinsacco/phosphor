import { useState } from 'react'
import clsx from 'clsx'
import { GLOBAL_INSTRUCTIONS_MAX_BYTES } from '@shared/global-instructions'
import { ModalOverlay } from '@/components/Modal'
import { Button } from '@/components/form'
import { TooltipButton } from '@/components/Tooltip'
import { Markdown } from '@/components/markdown/Markdown'
import { MonacoEditor } from '@/features/files/MonacoEditor'
import { promptChoice } from '@/stores/prompt'
import { fileName, sizeLabel, type InstructionsSource } from './instructionsSource'
import { useInstructionsFile, type InstructionsFile } from './useInstructionsFile'

/**
 * The full-window editor for one machine's global instructions: pi's own
 * global context file, which every lane on that machine loads (Phosphor lanes,
 * routines, sub-agents and pi in a terminal).
 *
 * Nothing is written until Save (or Cmd/Ctrl+S). Leaving with unsaved changes
 * asks first, and a backdrop click never closes it. A save over a file that
 * changed elsewhere is refused; Reload reads it again.
 */
export function InstructionsEditor({
  source,
  onClose,
}: {
  source: InstructionsSource
  onClose: () => void
}): React.JSX.Element {
  const state = useInstructionsFile(source)
  const [tab, setTab] = useState<'edit' | 'preview'>('edit')
  const { file, dirty } = state

  const close = async (): Promise<void> => {
    const what = file ? fileName(file.path) : 'the instructions'
    if (
      !dirty ||
      (await confirmed(DISCARD, `Your edits to ${what} on ${source.machine} are not saved.`))
    )
      onClose()
  }
  const reload = async (): Promise<void> => {
    if (
      !dirty ||
      (await confirmed(RELOAD, 'Your unsaved edits are replaced by the file as it is now.'))
    )
      await state.reload()
  }

  return (
    <ModalOverlay onClose={() => void close()} backdrop="strong" z={50} closeOnBackdrop={false}>
      <div
        role="dialog"
        aria-label={`Global instructions on ${source.machine}`}
        className="border-border bg-bg flex h-[92vh] w-[1100px] max-w-[96vw] flex-col overflow-hidden rounded-xl border shadow-2xl"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
            event.preventDefault()
            void state.save()
          }
        }}
      >
        <EditorHeader
          source={source}
          path={file?.path}
          exists={file?.exists}
          dirty={dirty}
          saving={state.saving}
          tab={tab}
          onTab={setTab}
          onClose={() => void close()}
          onSave={() => void state.save()}
        />
        <EditorBody source={source} state={state} tab={tab} onReload={() => void reload()} />
      </div>
    </ModalOverlay>
  )
}

function EditorHeader({
  source,
  path,
  exists,
  dirty,
  saving,
  tab,
  onTab,
  onClose,
  onSave,
}: {
  source: InstructionsSource
  path?: string
  exists?: boolean
  dirty: boolean
  saving: boolean
  tab: 'edit' | 'preview'
  onTab: (tab: 'edit' | 'preview') => void
  onClose: () => void
  onSave: () => void
}): React.JSX.Element {
  return (
    <div className="border-border flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-lg font-semibold">Global instructions on {source.machine}</div>
        <div className="text-text-tertiary truncate font-mono text-xs" data-tooltip={path}>
          {path ?? 'Reading…'}
          {path && exists === false ? ' (created on save)' : ''}
        </div>
      </div>
      <div className="flex items-center gap-1" role="tablist">
        {(['edit', 'preview'] as const).map((option) => (
          <TooltipButton
            key={option}
            role="tab"
            aria-selected={tab === option}
            onClick={() => onTab(option)}
            className={clsx(
              'rounded-md border px-2.5 py-1 text-sm capitalize',
              tab === option
                ? 'border-accent bg-accent-soft text-accent'
                : 'border-border text-text-secondary hover:border-border-strong',
            )}
          >
            {option}
          </TooltipButton>
        ))}
      </div>
      <Button size="sm" onClick={onClose}>
        {dirty ? 'Cancel' : 'Close'}
      </Button>
      <Button variant="primary" size="sm" disabled={!dirty || saving} onClick={onSave}>
        {saving ? 'Saving…' : 'Save'}
      </Button>
    </div>
  )
}

const DISCARD = {
  title: 'Discard unsaved changes?',
  keep: 'Keep editing',
  leave: 'Discard',
}
const RELOAD = { title: 'Reload from disk?', keep: 'Cancel', leave: 'Reload' }

/** True when the user chose to drop the unsaved draft. */
async function confirmed(
  copy: { title: string; keep: string; leave: string },
  message: string,
): Promise<boolean> {
  const choice = await promptChoice({
    title: copy.title,
    message,
    choices: [
      { value: 'keep', label: copy.keep, primary: true },
      { value: 'leave', label: copy.leave },
    ],
  })
  return choice === 'leave'
}

function EditorBody({
  source,
  state,
  tab,
  onReload,
}: {
  source: InstructionsSource
  state: InstructionsFile
  tab: 'edit' | 'preview'
  onReload: () => void
}): React.JSX.Element {
  const { file, draft } = state
  return (
    <>
      {state.error && (
        <div role="alert" className="text-danger flex items-center gap-3 px-4 py-2 text-sm">
          <span className="flex-1">{state.error}</span>
          <Button size="sm" onClick={onReload}>
            Reload
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        {file && tab === 'edit' && (
          <MonacoEditor
            path={`pi-instructions://${source.key}/${fileName(file.path)}`}
            language="markdown"
            value={draft}
            onChange={state.setDraft}
            onSave={() => void state.save()}
          />
        )}
        {file && tab === 'preview' && (
          <div className="h-full overflow-y-auto px-6 py-4">
            {draft.trim() ? (
              <Markdown text={draft} inAppLinks={false} />
            ) : (
              <p className="text-text-tertiary text-base">Nothing yet.</p>
            )}
          </div>
        )}
      </div>
      <div className="border-border text-text-tertiary flex flex-wrap gap-x-4 border-t px-4 py-2 text-xs">
        <span>
          {sizeLabel(draft)} of {GLOBAL_INSTRUCTIONS_MAX_BYTES / 1024} KB. Sent with every request
          on {source.machine}.
        </span>
        <span>Running lanes use a save from their next message.</span>
      </div>
    </>
  )
}
