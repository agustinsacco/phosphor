import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
import { Button } from '@/components/form'
import type { useRemoteModel } from './useRemoteModel'

function trapModelFocus(event: KeyboardEvent<HTMLDivElement>): void {
  if (event.key !== 'Tab') return
  const stops = event.currentTarget.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input[type="search"], input:checked',
  )
  const first = stops[0]
  const last = stops[stops.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first?.focus()
  }
}

/** Native radios supply arrow-key selection; the modal bounds long catalogues and labels. */
export function RemoteModelDialog({
  selection,
  onClose,
}: {
  selection: ReturnType<typeof useRemoteModel>
  onClose: () => void
}): React.JSX.Element {
  const group = useId()
  const [query, setQuery] = useState('')
  const models = selection.models.filter((model) =>
    `${model.name} ${model.provider} ${model.id}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  )
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    panel.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus()
  }, [])
  return (
    <ModalOverlay onClose={onClose}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Choose model"
        className="remote-model-dialog"
        onKeyDown={trapModelFocus}
      >
        <ModalPanel
          width={480}
          title="Choose model"
          footer={<Button onClick={onClose}>Done</Button>}
        >
          <p className="remote-model-explanation" role="status">
            {selection.explanation}
          </p>
          <div className="px-4 pb-2">
            <input
              type="search"
              aria-label="Search models"
              placeholder="Search models or providers…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="border-border bg-surface text-text w-full rounded-lg border px-3 py-2 text-base"
            />
          </div>
          <div className="remote-model-list" role="group" aria-label="Available models">
            {models.map((model) => (
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
            {models.length === 0 && query && (
              <p className="p-3 text-text-secondary">No matching models.</p>
            )}
            {selection.canRetry && (
              <Button onClick={() => void selection.retry()}>Retry models</Button>
            )}
          </div>
        </ModalPanel>
      </div>
    </ModalOverlay>
  )
}
