import { useEffect, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { AttachButton } from '@/components/ComposerButtons'
import { DictateButton } from '@/features/voice/DictateButton'
import { fuzzyFilter } from '@/lib/fuzzy'
import type { PendingAttachment } from '../attachments'
import { ComposerField, type ComposerFieldProps } from './ComposerField'
import { AttachmentChips, DropOverlay } from './AttachmentChips'
import { useAttachments } from './useAttachments'
import { FileMentionMenu } from './FileMentionMenu'
import { CommandMenu } from './CommandMenu'
import type { useSlashMenu } from './useSlashMenu'
import { SwarmControl, SwarmSwitch, swarmLook, useSwarm } from './SwarmSwitch'

interface ComposerInputProps extends Omit<ComposerFieldProps, 'onPasteFiles'> {
  workspacePath?: string
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
  const attachments = useAttachments({
    attachments: images,
    onChange: onAttachmentsChange,
    onReject: onWarning,
  })
  const liveSwarm = useSwarm('sessionId' in swarm ? swarm.sessionId : '')
  const enabled = 'sessionId' in swarm ? (liveSwarm?.enabled ?? false) : swarm.enabled
  const pending = 'sessionId' in swarm && swarmLook(liveSwarm) === 'pending'
  const [mention, setMention] = useState<{ anchor: number; query: string } | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [index, setIndex] = useState<{ workspacePath: string; files: string[] } | null>(null)
  useEffect(() => {
    if (!workspacePath || !mention || index?.workspacePath === workspacePath) return
    let cancelled = false
    void window.phosphor
      .invoke('fs:listFiles', workspacePath)
      .then((files) => {
        if (!cancelled) setIndex({ workspacePath, files })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [mention, workspacePath, index])
  // Sending/clearing a draft must close its popup, including attachment-only sends.
  useEffect(() => {
    if (!field.value) setMention(null)
  }, [field.value])
  const matches = useMemo(
    () =>
      mention && index && index.workspacePath === workspacePath
        ? fuzzyFilter(mention.query, index.files, (f) => f, 12)
        : [],
    [mention, index, workspacePath],
  )
  const change = (value: string, caret: number): void => {
    field.onChange(value, caret)
    slash.sync(value)
    const match = /(^|\s)@([^\s@]*)$/.exec(value.slice(0, caret))
    setMention(match ? { anchor: caret - match[2]!.length - 1, query: match[2]! } : null)
    setActiveIndex(0)
  }
  const pick = (file: string): void => {
    if (!mention) return
    const after = field.value.slice(mention.anchor + 1 + mention.query.length)
    const next =
      field.value.slice(0, mention.anchor) + file + (after.startsWith(' ') ? '' : ' ') + after
    field.onChange(next, mention.anchor + file.length + 1)
    setMention(null)
    field.textareaRef.current?.focus()
  }
  const keyDown: ComposerFieldProps['onKeyDown'] = (event) => {
    if (slash.handleKeyDown(event)) return true
    if (!slash.visible && mention && matches.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveIndex(
          (i) => (i + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length,
        )
        return true
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault()
        const file = matches[activeIndex]
        if (file) pick(file)
        return true
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setMention(null)
        return true
      }
    }
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
      {!slash.visible && mention && matches.length > 0 && (
        <FileMentionMenu
          files={matches}
          activeIndex={activeIndex}
          onHover={setActiveIndex}
          onPick={pick}
          onClose={() => setMention(null)}
        />
      )}
      <div
        data-swarm-enabled={enabled}
        onDragOver={workspacePath ? attachments.handleDragOver : undefined}
        onDragLeave={attachments.handleDragLeave}
        onDrop={workspacePath ? attachments.handleDrop : undefined}
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
          onPasteFiles={workspacePath ? attachments.addFiles : () => undefined}
          autocomplete={
            field.autocomplete !== false &&
            !slash.visible &&
            !mention &&
            !field.value.startsWith('!')
          }
        />
        {children}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2.5 pb-2">
          <div className="flex shrink-0 items-center gap-0.5">
            {workspacePath && <AttachButton onFiles={attachments.addFiles} />}
            <DictateButton textareaRef={field.textareaRef} onChange={change} />
            {workspacePath &&
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
