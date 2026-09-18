import { useState } from 'react'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
import { Button, TextInput } from '@/components/form'
import { usePromptStore, type PromptRequest } from '@/stores/prompt'

/**
 * Renders the head of the prompt queue (see stores/prompt.ts). Mounted once
 * in App next to the other hosts.
 */
export function PromptHost(): React.JSX.Element | null {
  const request = usePromptStore((s) => s.requests[0])
  if (!request) return null
  return <PromptSheet key={request.id} request={request} />
}

function PromptSheet({ request }: { request: PromptRequest }): React.JSX.Element {
  const [value, setValue] = useState(request.initialValue ?? '')
  const dismiss = (v: string | undefined): void => usePromptStore.getState().dismiss(request, v)

  const submit = (): void => {
    const trimmed = value
    if (!trimmed && !request.allowEmpty) dismiss(undefined)
    else dismiss(trimmed)
  }

  return (
    <ModalOverlay onClose={() => dismiss(undefined)}>
      <ModalPanel
        width={440}
        title={request.title}
        subtitle={request.message}
        footer={
          request.kind === 'display' ? (
            <Button variant="primary" onClick={() => dismiss(undefined)}>
              Close
            </Button>
          ) : (
            <>
              <Button onClick={() => dismiss(undefined)}>Cancel</Button>
              <Button variant="primary" onClick={submit}>
                {request.submitLabel ?? 'OK'}
              </Button>
            </>
          )
        }
      >
        <div className="px-4 py-3">
          {request.kind === 'display' ? (
            <textarea
              readOnly
              autoFocus
              onFocus={(e) => e.target.select()}
              value={request.text}
              rows={10}
              className="border-border bg-code-bg text-text w-full resize-y rounded-lg border px-3 py-2 font-mono text-base outline-none focus:border-[var(--px-border-strong)]"
            />
          ) : (
            <TextInput
              size="lg"
              data-testid="prompt-input"
              autoFocus
              onFocus={(e) => e.target.select()}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
              }}
              placeholder={request.placeholder}
              className="w-full"
            />
          )}
        </div>
      </ModalPanel>
    </ModalOverlay>
  )
}
