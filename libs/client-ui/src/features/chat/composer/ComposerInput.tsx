import { usePlatform } from '@/platform/Platform'
import { useMemo, type ReactNode } from 'react'
import clsx from 'clsx'
import { AttachButton } from '@/components/ComposerButtons'
import { DictateButton } from '@/features/voice/DictateButton'
import type { PendingAttachment } from '../attachments'
import { ComposerField, type ComposerFieldProps } from './ComposerField'
import { AttachmentChips, DropOverlay } from './AttachmentChips'
import { useAttachments } from './useAttachments'
import { FileMentionMenu } from './FileMentionMenu'
import { CommandMenu } from './CommandMenu'
import type { useSlashMenu } from './useSlashMenu'
import { SwarmControl, SwarmSwitch, swarmLook, useSwarm } from './SwarmSwitch'
import { useFileMentions, workspaceFileSource, type FileMentionSource } from './useFileMentions'

interface ComposerInputProps extends Omit<ComposerFieldProps, 'onPasteFiles'> {
  remoteAttachments?: boolean
  workspacePath?: string
  /** Where `@` reads files. Defaults to the workspace's own; null offers none. */
  fileSource?: FileMentionSource | null
  attachments: PendingAttachment[]
  onAttachmentsChange: (attachments: PendingAttachment[]) => void
  onWarning: (message: string) => void
  swarm: { sessionId: string } | { enabled: boolean; onChange: (enabled: boolean) => void }
  slash: ReturnType<typeof useSlashMenu>
  commandStatus?: 'idle' | 'loading' | 'ready' | 'error'
  commandError?: string
  modelPicker: ReactNode
  actions: ReactNode
  scopeStatus?: ReactNode
  children?: ReactNode
}

/** The input card for both new and existing lanes. Only lifecycle controls are slots. */
export function ComposerInput({
  workspacePath,
  remoteAttachments = false,
  fileSource,
  attachments: images,
  onAttachmentsChange,
  onWarning,
  swarm,
  slash,
  commandStatus,
  commandError,
  modelPicker,
  actions,
  scopeStatus,
  children,
  ...field
}: ComposerInputProps): React.JSX.Element {
  const platform = usePlatform()
  const canAttach = (!!workspacePath && !workspacePath.startsWith('host:')) || remoteAttachments
  const attachments = useAttachments({
    remote: remoteAttachments,
    attachments: images,
    onChange: onAttachmentsChange,
    onReject: onWarning,
  })
  const liveSwarm = useSwarm('sessionId' in swarm ? swarm.sessionId : '')
  const enabled = 'sessionId' in swarm ? (liveSwarm?.enabled ?? false) : swarm.enabled
  const pending = 'sessionId' in swarm && swarmLook(liveSwarm) === 'pending'
  const workspaceFiles = useMemo(
    () => (workspacePath ? workspaceFileSource(workspacePath) : null),
    [workspacePath],
  )
  const mention = useFileMentions({
    source: fileSource === undefined ? workspaceFiles : fileSource,
    value: field.value,
    onChange: field.onChange,
    textareaRef: field.textareaRef,
  })
  const change = (value: string, caret: number): void => {
    field.onChange(value, caret)
    slash.sync(value)
    mention.track(value, caret)
  }
  const keyDown: ComposerFieldProps['onKeyDown'] = (event) => {
    if (slash.handleKeyDown(event)) return true
    if (!slash.visible && mention.handleKeyDown(event)) return true
    return field.onKeyDown?.(event) ?? false
  }
  return (
    <>
      {slash.visible && (
        <CommandMenu
          query={slash.query ?? ''}
          entries={slash.matches}
          status={commandStatus}
          errorMessage={commandError}
          activeIndex={slash.activeIndex}
          onHover={slash.setActiveIndex}
          onPick={slash.pick}
          onClose={slash.close}
        />
      )}
      {!slash.visible && mention.open && mention.matches.length > 0 && (
        <FileMentionMenu
          files={mention.matches}
          activeIndex={mention.activeIndex}
          onHover={mention.setActiveIndex}
          onPick={mention.pick}
          onClose={mention.close}
        />
      )}
      <div
        data-swarm-enabled={enabled}
        onDragOver={canAttach ? attachments.handleDragOver : undefined}
        onDragLeave={attachments.handleDragLeave}
        onDrop={canAttach ? attachments.handleDrop : undefined}
        className={clsx(
          'bg-surface relative rounded-xl border shadow-sm transition-colors',
          attachments.dragging
            ? 'border-accent ring-accent/25 ring-2'
            : pending
              ? 'border-accent/60 border-dashed'
              : enabled
                ? 'border-accent ring-accent/10 ring-1'
                : 'border-border hover:border-border-focus focus-within:border-border-focus',
        )}
      >
        <DropOverlay visible={attachments.dragging} />
        <AttachmentChips
          attachments={images}
          onRemove={attachments.remove}
          onEdit={attachments.edit}
        />
        <ComposerField
          {...field}
          onChange={change}
          onKeyDown={keyDown}
          onPasteFiles={canAttach ? attachments.addFiles : () => undefined}
          autocomplete={
            field.autocomplete !== false &&
            !slash.visible &&
            !mention.open &&
            !field.value.startsWith('!')
          }
        />
        {children}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2.5 pb-2">
          <div className="flex shrink-0 items-center gap-0.5">
            {canAttach && <AttachButton onFiles={attachments.addFiles} />}
            {platform.localLanes && (
              <DictateButton textareaRef={field.textareaRef} onChange={change} />
            )}
            {workspacePath &&
              !workspacePath.startsWith('host:') &&
              ('sessionId' in swarm ? (
                <SwarmSwitch sessionId={swarm.sessionId} />
              ) : (
                <SwarmControl
                  state={{ version: 1, available: true, enabled, requested: enabled }}
                  hint="Authorize delegation for this new lane. Requires pi-subagents; checked before the first prompt. Nothing launches until you send."
                  onToggle={() => swarm.onChange(!enabled)}
                />
              ))}
            {scopeStatus}
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-1.5">
            {modelPicker}
            {actions}
          </div>
        </div>
      </div>
    </>
  )
}
