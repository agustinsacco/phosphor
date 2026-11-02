import type { ReactNode, RefObject } from 'react'
import { SubmitIconButton } from '@/components/ComposerButtons'
import { WaitingNote } from '@/components/Waiting'
import { ComposerInput } from '@/features/chat/composer/ComposerInput'
import type { SlashMenu } from '@/features/chat/composer/useSlashMenu'
import type { FileMentionSource } from '@/features/chat/composer/useFileMentions'
import type { PendingAttachment } from '@/features/chat/attachments'
import './startComposer.css'

/**
 * What one machine supplies to the new-lane composer: This Mac through
 * `useLocalStart`, a Host through `RemoteStartView`. Layout, labels and the
 * note line are the composer's; a target only says what it can offer.
 */
export interface StartTarget {
  text: string
  setText: (text: string) => void
  attachments: PendingAttachment[]
  setAttachments: (attachments: PendingAttachment[]) => void
  /** This Mac's folder: local attachments need it. */
  workspacePath?: string
  /** A Host takes attachments through its own upload. */
  remoteAttachments: boolean
  /** Where `@` reads files, or null when this target has none to offer. */
  files: FileMentionSource | null
  /** The `/` menu, or null when this target has no commands before a lane exists. */
  slash: SlashMenu | null
  commandStatus?: 'idle' | 'loading' | 'ready' | 'error'
  commandError?: string
  swarm: { enabled: boolean; onChange: (enabled: boolean) => void } | null
  modelPicker: ReactNode
  /** After the machine picker: where the lane runs, then the isolate toggle. */
  targets: ReactNode
  contextSources: ReactNode
  busy: boolean
  canSubmit: boolean
  submit: () => Promise<void>
  /** Nothing typed could start a lane yet. */
  locked: boolean
  /** What the locked field waits for, while its machine connects. */
  waiting: string | null
  status: string | null
  warning: string | null
  setWarning: (warning: string | null) => void
}

const NO_SLASH: SlashMenu = {
  query: null,
  matches: [],
  visible: false,
  activeIndex: 0,
  setActiveIndex: () => undefined,
  close: () => undefined,
  sync: () => undefined,
  handleKeyDown: () => false,
  pick: () => undefined,
}
/** The one new-lane composer, for This Mac and every Host, at every width. */
export function StartComposer({
  target: t,
  textareaRef,
  machinePicker,
}: {
  target: StartTarget
  textareaRef: RefObject<HTMLTextAreaElement | null>
  machinePicker: ReactNode
}): React.JSX.Element {
  return (
    <section className="start-composer" aria-label="New lane">
      <div className="start-composer-targets mb-2 flex flex-wrap items-center gap-1.5 px-0.5">
        {machinePicker}
        {t.targets}
      </div>
      {/* Sending locks the field too: an edit made now would not be what was sent. */}
      <fieldset
        disabled={t.locked || t.busy}
        aria-busy={t.waiting || t.busy ? true : undefined}
        className="start-composer-field min-w-0"
      >
        <ComposerInput
          workspacePath={t.workspacePath}
          remoteAttachments={t.remoteAttachments}
          fileSource={t.files}
          value={t.text}
          textareaRef={textareaRef}
          onChange={t.setText}
          onSubmit={() => void t.submit()}
          placeholder="Describe a task or ask a question"
          rows={2}
          attachments={t.attachments}
          onAttachmentsChange={t.setAttachments}
          onWarning={t.setWarning}
          slash={t.slash ?? NO_SLASH}
          commandStatus={t.commandStatus}
          commandError={t.commandError}
          swarm={t.swarm}
          modelPicker={t.modelPicker}
          actions={
            <SubmitIconButton
              busy={t.busy}
              disabled={!t.canSubmit}
              onClick={() => void t.submit()}
              label="Start lane"
            />
          }
        />
      </fieldset>
      <div className="text-text-tertiary @container flex min-h-6 flex-wrap items-center gap-x-3 gap-y-0.5 px-2 pt-1.5 text-sm">
        {t.contextSources}
        {t.text === '' && <StartHints commands={!!t.slash} files={!!t.files} />}
      </div>
      <StartNote target={t} />
    </section>
  )
}

function StartHints({ commands, files }: { commands: boolean; files: boolean }) {
  if (!commands && !files) return null
  return (
    <span className="@xl:inline ml-auto hidden min-w-0 flex-1 basis-0 truncate text-right">
      {commands && (
        <>
          <span className="font-mono">/</span> commands
        </>
      )}
      {commands && files && ' · '}
      {files && (
        <>
          <span className="font-mono">@</span> files
        </>
      )}
    </span>
  )
}

/** One line at most: a warning, else what the field waits for, else why it cannot start. */
function StartNote({ target: t }: { target: StartTarget }): React.JSX.Element | null {
  if (t.warning)
    return (
      <p role="alert" className="text-warning start-composer-note">
        {t.warning}
      </p>
    )
  if (t.waiting) return <WaitingNote className="start-composer-note">{t.waiting}</WaitingNote>
  if (t.status)
    return (
      <p role="status" className="text-text-tertiary start-composer-note">
        {t.status}
      </p>
    )
  return null
}
