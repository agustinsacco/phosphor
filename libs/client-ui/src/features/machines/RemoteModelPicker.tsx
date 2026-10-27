import { useRef, useState } from 'react'
import { useMachinesStore } from '@/stores/machines'
import { Button } from '@/components/form'
import { TooltipButton } from '@/components/Tooltip'
import { supportedThinkingLevels } from '@shared/thinking'
import { machineLabel } from '@/stores/remoteLanes'
import { ChoiceMenu } from '@/components/ChoiceMenu'
import { usePlatform } from '@/platform/Platform'
import { RemoteModelDialog } from './RemoteModelDialog'
import { RemoteModelChips } from './RemoteModelChips'
import type { useRemoteModel } from './useRemoteModel'
import './remoteModel.css'

export { useRemoteModel } from './useRemoteModel'

/**
 * Expanded width uses the composer's chips, the same picker as This Mac's home
 * and every lane; a phone gets the bounded full-screen dialog.
 */
export function RemoteModelPicker({
  selection,
}: {
  selection: ReturnType<typeof useRemoteModel>
}): React.JSX.Element {
  const compact = usePlatform().formFactor === 'compact'
  return (
    <div className="remote-model-picker">
      {compact ? (
        <CompactRemoteModelPicker selection={selection} />
      ) : (
        <RemoteModelChips selection={selection} />
      )}
      {selection.canRetry && (
        <Button size="sm" onClick={() => void selection.retry()}>
          Retry models
        </Button>
      )}
      {selection.missingModel && (
        <Button
          size="sm"
          onClick={() =>
            useMachinesStore.getState().show({ kind: 'machine', id: selection.hostId })
          }
        >
          Sign in on {machineLabel(selection.hostId)}
        </Button>
      )}
    </div>
  )
}

/** One bounded model list on a phone; thinking keeps the shared choice primitive. */
function CompactRemoteModelPicker({
  selection,
}: {
  selection: ReturnType<typeof useRemoteModel>
}): React.JSX.Element {
  const { model, thinking, setThinking } = selection
  const levels = model ? supportedThinkingLevels(model) : []
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const close = () => {
    setOpen(false)
    trigger.current?.focus()
  }
  return (
    <>
      <TooltipButton
        ref={trigger}
        type="button"
        aria-label="Model"
        data-testid="remote-model-picker"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="remote-model-trigger"
        onClick={() => setOpen(true)}
        title={model?.name ?? selection.hint}
      >
        {model?.name ?? selection.hint}
      </TooltipButton>
      {levels.length > 1 && (
        <ChoiceMenu
          escapeContainer
          label="Thinking"
          value={thinking}
          choices={levels.map((level) => ({
            value: level,
            label: level === 'off' ? 'No thinking' : level,
          }))}
          onChange={(value) => {
            const level = levels.find((level) => level === value)
            if (level) setThinking(level)
          }}
        >
          <span className="truncate">{thinking === 'off' ? 'No thinking' : thinking}</span>
        </ChoiceMenu>
      )}
      {open && <RemoteModelDialog selection={selection} onClose={close} />}
    </>
  )
}
