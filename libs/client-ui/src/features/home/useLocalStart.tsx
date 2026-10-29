import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react'
import { WorkspaceChip } from '@/features/workspaces/WorkspaceChip'
import { BranchControl } from '@/features/worktrees/BranchControl'
import { ContextSourcesMenu } from '@/features/chat/composer/ContextSourcesMenu'
import { buildCommandEntries } from '@/features/chat/composer/CommandMenu'
import { useSlashMenu } from '@/features/chat/composer/useSlashMenu'
import { workspaceFileSource } from '@/features/chat/composer/useFileMentions'
import type { PendingAttachment } from '@/features/chat/attachments'
import { homeDraftKey, useDraftsStore, type Draft } from '@/stores/drafts'
import { useStartingChatStore } from '@/stores/startingChat'
import { useHomeSubmissionsStore } from '@/stores/homeSubmissions'
import { useWorktreesStore } from '@/stores/worktrees'
import { NO_COMMANDS, usePiCommandsStore } from '@/stores/piCommands'
import { HomeModelPicker } from './HomeModelPicker'
import { IsolateToggle } from './IsolateToggle'
import { submitLocalHome } from './submitLocalHome'
import type { StartTarget } from './StartComposer'

const EMPTY_ATTACHMENTS: PendingAttachment[] = []

/** This Mac as a start target: its workspace draft, slash probe and immediate starting screen. */
export function useLocalStart(
  workspacePath: string,
  textareaRef: RefObject<HTMLTextAreaElement | null>,
): StartTarget {
  const draftKey = homeDraftKey(workspacePath)
  const draft = useDraftsStore((s) => s.drafts[draftKey])
  const text = draft?.text ?? ''
  const images = draft?.attachments ?? EMPTY_ATTACHMENTS
  const swarm = draft?.swarm ?? false
  const setText = useCallback(
    (next: string) => useDraftsStore.getState().setText(draftKey, next),
    [draftKey],
  )
  const [warning, setWarning] = useState<string | null>(null)
  const isRepo = useLocalRepo(workspacePath, textareaRef)
  const isolate = useWorktreesStore((s) => s.preferWorktree)
  const starting = useStartingChatStore((s) => s.starting !== null)
  const commands = useLocalCommands(workspacePath, setText, textareaRef)
  const files = useMemo(() => workspaceFileSource(workspacePath), [workspacePath])
  useFailedStartRestore(workspacePath, setWarning, textareaRef)
  const patch = (next: Partial<Draft>) => useDraftsStore.getState().patch(draftKey, next)
  return {
    text,
    setText,
    attachments: images,
    setAttachments: (next) => useDraftsStore.getState().setAttachments(draftKey, next),
    workspacePath,
    remoteAttachments: false,
    files,
    ...commands,
    swarm: { enabled: swarm, onChange: (enabled) => patch({ swarm: enabled }) },
    modelPicker: <HomeModelPicker override={draft?.model} onPick={(model) => patch({ model })} />,
    targets: (
      <>
        <WorkspaceChip workspacePath={workspacePath} />
        {isRepo && <BranchControl workspacePath={workspacePath} />}
        {isRepo && (
          <IsolateToggle checked={isolate} disabled={starting} workspacePath={workspacePath} />
        )}
      </>
    ),
    contextSources: <ContextSourcesMenu workspacePath={workspacePath} />,
    busy: starting,
    canSubmit: !!text.trim() || images.length > 0,
    submit: async () => {
      if (
        (!text.trim() && !images.length) ||
        useStartingChatStore.getState().starting ||
        useHomeSubmissionsStore.getState().pending[draftKey]
      )
        return
      setWarning(null)
      await submitLocalHome(workspacePath, text.trim(), images, swarm)
    },
    locked: false,
    waiting: null,
    status: null,
    warning,
    setWarning,
  }
}

function useLocalCommands(
  workspacePath: string,
  setText: (text: string) => void,
  textareaRef: RefObject<HTMLTextAreaElement | null>,
) {
  const piCommands = usePiCommandsStore((s) => s.byWorkspace[workspacePath] ?? NO_COMMANDS)
  const commandStatus = usePiCommandsStore((s) => s.status[workspacePath] ?? ('idle' as const))
  const commandError = usePiCommandsStore((s) => s.error[workspacePath])
  const entries = useMemo(() => buildCommandEntries(piCommands, []), [piCommands])
  const slash = useSlashMenu({
    entries,
    setText,
    onOpen: () => void usePiCommandsStore.getState().load(workspacePath),
    focus: () => textareaRef.current?.focus(),
  })
  return { slash, commandStatus, commandError }
}

/** A start that failed after Home unmounted comes back into this workspace's draft. */
function useFailedStartRestore(
  workspacePath: string,
  setWarning: (warning: string | null) => void,
  textareaRef: RefObject<HTMLTextAreaElement | null>,
): void {
  const failedDraft = useStartingChatStore((s) => s.draft)
  useEffect(() => {
    if (!failedDraft || failedDraft.workspacePath !== workspacePath) return
    useDraftsStore.getState().patch(homeDraftKey(workspacePath), {
      text: failedDraft.text,
      attachments: failedDraft.attachments,
      swarm: failedDraft.swarm,
      workspacePath,
    })
    setWarning(failedDraft.message)
    useStartingChatStore.getState().clearDraft()
    textareaRef.current?.focus()
  }, [failedDraft, workspacePath, setWarning, textareaRef])
}

function useLocalRepo(
  workspacePath: string,
  textareaRef: RefObject<HTMLTextAreaElement | null>,
): boolean {
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
