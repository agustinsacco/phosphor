import { useCallback, useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react'
import { SubmitIconButton } from '@/components/ComposerButtons'
import { WorkspaceChip } from '@/features/workspaces/WorkspaceChip'
import { BranchControl } from '@/features/worktrees/BranchControl'
import { ComposerInput } from '@/features/chat/composer/ComposerInput'
import { ContextSourcesMenu } from '@/features/chat/composer/ContextSourcesMenu'
import { buildCommandEntries } from '@/features/chat/composer/CommandMenu'
import { useSlashMenu } from '@/features/chat/composer/useSlashMenu'
import type { PendingAttachment } from '@/features/chat/attachments'
import { homeDraftKey, useDraftsStore } from '@/stores/drafts'
import { useStartingChatStore } from '@/stores/startingChat'
import { useHomeSubmissionsStore } from '@/stores/homeSubmissions'
import { useWorktreesStore } from '@/stores/worktrees'
import { NO_COMMANDS, usePiCommandsStore } from '@/stores/piCommands'
import { HomeModelPicker } from './HomeModelPicker'
import { IsolateToggle } from './IsolateToggle'
import { submitLocalHome } from './submitLocalHome'

interface Props {
  workspacePath: string
  textareaRef: RefObject<HTMLTextAreaElement | null>
  machinePicker: ReactNode
}
const EMPTY_ATTACHMENTS: PendingAttachment[] = []

/** Native creation keeps its workspace draft, slash probe and immediate starting screen. */
export function LocalHomeComposer(props: Props): React.JSX.Element {
  const { workspacePath, textareaRef, machinePicker } = props
  const c = useLocalHomeComposer(props)
  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-1.5 px-0.5">
        {machinePicker}
        <WorkspaceChip workspacePath={workspacePath} />
        {c.isRepo && <BranchControl workspacePath={workspacePath} />}
        {c.isRepo && (
          <IsolateToggle checked={c.isolate} disabled={c.starting} workspacePath={workspacePath} />
        )}
      </div>
      <ComposerInput
        workspacePath={workspacePath}
        value={c.text}
        textareaRef={textareaRef}
        onChange={c.setText}
        onSubmit={() => void c.start()}
        placeholder="Describe a task or ask a question"
        rows={2}
        attachments={c.images}
        onAttachmentsChange={c.setImages}
        onWarning={c.setWarning}
        slash={c.slash}
        commandStatus={c.commandsStatus}
        commandError={c.commandsError}
        swarm={{
          enabled: c.swarm,
          onChange: (swarm) => useDraftsStore.getState().patch(c.draftKey, { swarm }),
        }}
        modelPicker={
          <HomeModelPicker
            override={c.draft?.model}
            onPick={(model) => useDraftsStore.getState().patch(c.draftKey, { model })}
          />
        }
        actions={
          <SubmitIconButton
            busy={c.starting}
            disabled={!c.text.trim() && c.images.length === 0}
            onClick={() => void c.start()}
            label="Start session"
          />
        }
      />
      <div className="text-text-tertiary @container flex min-h-6 flex-wrap items-center gap-x-3 gap-y-0.5 px-2 pt-1.5 text-sm">
        <ContextSourcesMenu workspacePath={workspacePath} />
        {c.text === '' && (
          <span className="@xl:inline ml-auto hidden min-w-0 flex-1 basis-0 truncate text-right">
            <span className="font-mono">/</span> commands · <span className="font-mono">@</span>{' '}
            files
          </span>
        )}
      </div>
      {c.warning && <p className="text-warning mt-2 px-1 text-sm">{c.warning}</p>}
    </>
  )
}

function useLocalHomeComposer({ workspacePath, textareaRef }: Props) {
  const draftKey = homeDraftKey(workspacePath)
  const draft = useDraftsStore((s) => s.drafts[draftKey])
  const text = draft?.text ?? ''
  const images = draft?.attachments ?? EMPTY_ATTACHMENTS
  const swarm = draft?.swarm ?? false
  const setText = useCallback(
    (next: string) => useDraftsStore.getState().setText(draftKey, next),
    [draftKey],
  )
  const setImages = (next: PendingAttachment[]) =>
    useDraftsStore.getState().setAttachments(draftKey, next)
  const [warning, setWarning] = useState<string | null>(null)
  const isRepo = useLocalRepo(workspacePath, textareaRef)
  const isolate = useWorktreesStore((s) => s.preferWorktree)
  const starting = useStartingChatStore((s) => s.starting !== null)
  const failedDraft = useStartingChatStore((s) => s.draft)
  const piCommands = usePiCommandsStore((s) => s.byWorkspace[workspacePath] ?? NO_COMMANDS)
  const commandsStatus = usePiCommandsStore((s) => s.status[workspacePath] ?? ('idle' as const))
  const commandsError = usePiCommandsStore((s) => s.error[workspacePath])
  const commandEntries = useMemo(() => buildCommandEntries(piCommands, []), [piCommands])
  const slash = useSlashMenu({
    entries: commandEntries,
    setText,
    onOpen: () => void usePiCommandsStore.getState().load(workspacePath),
    focus: () => textareaRef.current?.focus(),
  })
  useEffect(() => {
    if (!failedDraft || failedDraft.workspacePath !== workspacePath) return
    useDraftsStore.getState().patch(draftKey, {
      text: failedDraft.text,
      attachments: failedDraft.attachments,
      swarm: failedDraft.swarm,
      workspacePath,
    })
    setWarning(failedDraft.message)
    useStartingChatStore.getState().clearDraft()
    textareaRef.current?.focus()
  }, [failedDraft, workspacePath, draftKey, textareaRef])
  const start = async (): Promise<void> => {
    if (
      (!text.trim() && !images.length) ||
      useStartingChatStore.getState().starting ||
      useHomeSubmissionsStore.getState().pending[draftKey]
    )
      return
    setWarning(null)
    await submitLocalHome(workspacePath, text.trim(), images, swarm)
  }
  return {
    draftKey,
    draft,
    text,
    images,
    swarm,
    setText,
    setImages,
    warning,
    setWarning,
    isRepo,
    isolate,
    starting,
    commandsStatus,
    commandsError,
    slash,
    start,
  }
}

function useLocalRepo(workspacePath: string, textareaRef: Props['textareaRef']): boolean {
  const [isRepo, setIsRepo] = useState(false)
  useEffect(() => {
    let current = true
    void window.phosphor
      .invoke('git:info', workspacePath)
      .then((info) => {
        if (current) setIsRepo(info.isRepo)
      })
      .catch(() => {
        if (current) setIsRepo(false)
      })
    textareaRef.current?.focus()
    return () => {
      current = false
    }
  }, [workspacePath, textareaRef])
  return isRepo
}
