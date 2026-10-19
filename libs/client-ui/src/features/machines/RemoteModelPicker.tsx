import { useRef, useState } from 'react'
import { useMachinesStore } from '@/stores/machines'
import { Button } from '@/components/form'
import { supportedThinkingLevels } from '@shared/thinking'
import { machineLabel } from '@/stores/remoteLanes'
import { ChoiceMenu } from '@/components/ChoiceMenu'
import { RemoteModelDialog } from './RemoteModelDialog'
import type { useRemoteModel } from './useRemoteModel'
import './remoteModel.css'

export { useRemoteModel } from './useRemoteModel'

/** One bounded model list on phones and Desktop; thinking keeps the shared choice primitive. */
export function RemoteModelPicker({
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
    <div className="remote-model-picker">
      <button
        ref={trigger}
        type="button"
        aria-label="Model"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="remote-model-trigger"
        onClick={() => setOpen(true)}
        title={model?.name ?? selection.hint}
      >
        {model?.name ?? selection.hint}
      </button>
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
      {levels.length > 1 && (
        <ChoiceMenu
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
    </div>
  )
}
