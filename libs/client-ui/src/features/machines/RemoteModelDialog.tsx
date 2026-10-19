import { useEffect, useId, useRef } from 'react'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
import { Button } from '@/components/form'
import type { useRemoteModel } from './useRemoteModel'

/** Native radios supply arrow-key selection; the modal bounds long catalogues and labels. */
export function RemoteModelDialog({
  selection,
  onClose,
}: {
  selection: ReturnType<typeof useRemoteModel>
  onClose: () => void
}): React.JSX.Element {
  const group = useId()
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = panel.current
    const selected = element?.querySelector<HTMLInputElement>('input:checked')
    ;(selected ?? element?.querySelector<HTMLButtonElement>('button'))?.focus()
  }, [])
  return (
    <ModalOverlay onClose={onClose}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Choose model"
        className="remote-model-dialog"
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return
          // Radios share one tab stop. Include only the selected radio in the trap.
          const stops = [
            ...(panel.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:checked',
            ) ?? []),
          ]
          const first = stops[0]
          const last = stops.at(-1)
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last?.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first?.focus()
          }
        }}
      >
        <ModalPanel
          width={480}
          title="Choose model"
          footer={<Button onClick={onClose}>Done</Button>}
        >
          <p className="remote-model-explanation" role="status">
            {selection.explanation}
          </p>
          <div className="remote-model-list" role="group" aria-label="Available models">
            {selection.models.map((model) => (
              <label key={`${model.provider}/${model.id}`} className="remote-model-option">
                <input
                  type="radio"
                  name={group}
                  checked={
                    selection.model?.id === model.id && selection.model.provider === model.provider
                  }
                  onChange={() => selection.choose(model)}
                />
                <span>
                  <span className="block">{model.name}</span>
                  <span className="text-text-tertiary text-xs">
                    {model.provider} · {model.id}
                  </span>
                </span>
              </label>
            ))}
            {selection.canRetry && (
              <Button onClick={() => void selection.retry()}>Retry models</Button>
            )}
          </div>
        </ModalPanel>
      </div>
    </ModalOverlay>
  )
}
