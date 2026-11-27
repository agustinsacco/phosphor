import { useEffect, useRef, useState } from 'react'
import { BRAIN_TELL_MAX } from '@shared/brain'
import type { HostBrainLanePage } from '@shared/host-brain'
import type { ExtensionUIRequest, ExtensionUIResponse } from '@shared/rpc'
import { Button } from '@/components/form'
import { ignoreShortcut } from '@/lib/shortcutContext'
import { useBrainRequest, type ReadyBrainSurface } from './useHostBrain'

export function HostBrainAgent({ brain }: { brain: ReadyBrainSurface }): React.JSX.Element {
  const [older, setOlder] = useState<HostBrainLanePage[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const latest = useConversationPage(brain, busy)
  const page = latest.data
  const cursor = older[0] ? older[0].next : page?.next
  const act = async (operation: () => Promise<unknown>, refresh = true) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      await operation()
    } catch {
      setError('The Host did not confirm that action. Check Brain Agent before trying again.')
    } finally {
      inFlight.current = false
      setBusy(false)
      if (refresh) latest.retry()
    }
  }
  const entries = [
    ...new Map(
      [...older, ...(page ? [page] : [])].flatMap((p) =>
        p.entries.map((entry) => [entry.id, entry] as const),
      ),
    ).values(),
  ]
  return (
    <section aria-label="Brain Agent" className="mx-auto w-full max-w-3xl space-y-4">
      <h2 className="text-lg font-semibold">Private conversation</h2>
      {error && <p role="alert">{error}</p>}
      {!page ? (
        <div className="flex flex-wrap items-center gap-2 text-text-secondary">
          <p role="status">
            {latest.error ? 'The Host did not provide the conversation.' : 'Loading conversation…'}
          </p>
          {latest.error && (
            <Button size="sm" onClick={latest.retry}>
              Retry
            </Button>
          )}
        </div>
      ) : (
        <>
          {cursor && (
            <Button
              disabled={busy}
              size="xs"
              onClick={() =>
                void act(async () => {
                  const next = await brain.invoke<'brain:laneWatch'>({
                    method: 'brain:laneWatch',
                    args: [cursor],
                  })
                  setOlder((pages) => [next, ...pages])
                }, false)
              }
            >
              Older messages
            </Button>
          )}
          <AgentTranscript entries={entries} />
          <AgentControls
            page={page}
            brain={brain}
            draft={draft}
            setDraft={setDraft}
            busy={busy}
            act={act}
          />
        </>
      )}
    </section>
  )
}

function useConversationPage(brain: ReadyBrainSurface, busy: boolean) {
  const latest = useBrainRequest<'brain:laneShow'>(
    brain,
    { method: 'brain:laneShow', args: [] },
    // Saving knowledge does not reset the conversation; the Host's generation still does.
    { trackRevision: false },
  )
  const { retry } = latest
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden && !busy) retry()
    }, 2000)
    return () => window.clearInterval(timer)
  }, [busy, retry])
  return latest
}

function AgentTranscript({ entries }: { entries: HostBrainLanePage['entries'] }) {
  return (
    <>
      {entries.length === 0 && <p className="text-text-secondary">No messages yet.</p>}
      <ol aria-label="Transcript" className="space-y-3">
        {entries.map((entry) => (
          <li
            key={entry.id}
            className={entry.role === 'user' ? 'rounded-md bg-user-bubble p-3' : 'px-3 py-2'}
          >
            <strong className="text-base font-semibold text-text-secondary">
              {entry.role === 'user' ? 'You' : 'Brain Agent'}
            </strong>
            <p className="whitespace-pre-wrap wrap-anywhere [font-size:var(--px-chat-font-size)]">
              {entry.text}
            </p>
          </li>
        ))}
      </ol>
    </>
  )
}

function AgentControls({
  page,
  brain,
  draft,
  setDraft,
  busy,
  act,
}: {
  page: HostBrainLanePage
  brain: ReadyBrainSurface
  draft: string
  setDraft: (draft: string) => void
  busy: boolean
  act: (operation: () => Promise<unknown>) => Promise<void>
}): React.JSX.Element {
  const held = page.controller?.self === true
  const { fence, turn } = page
  const reason = !page.messaging
    ? 'Read-only. This Host can’t send messages yet.'
    : page.controller && !held
      ? 'Read-only. Another client has control.'
      : page.running
        ? 'Brain Agent is working.'
        : null
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {reason && (
          <p role="status" className="text-text-secondary">
            {reason}
          </p>
        )}
        {!held && (page.controller || page.dialogs.length > 0) && (
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              void act(() =>
                brain.invoke<'brain:laneTake'>({ method: 'brain:laneTake', args: [fence] }),
              )
            }
          >
            Take control
          </Button>
        )}
        {page.running && held && turn && (
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              void act(() =>
                brain.invoke<'brain:laneStop'>({ method: 'brain:laneStop', args: [fence, turn] }),
              )
            }
          >
            Stop
          </Button>
        )}
      </div>
      <AgentDialogs page={page} brain={brain} disabled={!held || busy} act={act} />
      {!reason && (
        <AgentComposer
          busy={busy}
          draft={draft}
          setDraft={setDraft}
          send={() =>
            void act(async () => {
              await brain.invoke<'brain:laneSend'>({
                method: 'brain:laneSend',
                args: [draft.trim(), fence],
              })
              setDraft('')
            })
          }
        />
      )}
    </>
  )
}

/** The questions the Host shows this caller: only those from the turn they started. */
function AgentDialogs({
  page,
  brain,
  disabled,
  act,
}: {
  page: HostBrainLanePage
  brain: ReadyBrainSurface
  disabled: boolean
  act: (operation: () => Promise<unknown>) => Promise<void>
}) {
  const { fence } = page
  return page.dialogs.map((dialog) => (
    <AgentDialog
      key={JSON.stringify([fence, dialog.id])}
      dialog={dialog}
      disabled={disabled}
      answer={(answer) =>
        void act(() =>
          brain.invoke<'brain:laneAnswer'>({ method: 'brain:laneAnswer', args: [answer, fence] }),
        )
      }
    />
  ))
}

function AgentComposer({
  busy,
  draft,
  setDraft,
  send,
}: {
  busy: boolean
  draft: string
  setDraft: (value: string) => void
  send: () => void
}) {
  const canSend = !busy && !!draft.trim()
  return (
    <form
      aria-label="Brain Agent composer"
      className="rounded-composer border border-border bg-surface p-2 focus-within:border-border-focus"
      onSubmit={(event) => {
        event.preventDefault()
        if (canSend) send()
      }}
    >
      <textarea
        aria-label="Message for Brain Agent"
        placeholder="Message Brain Agent"
        className="block w-full resize-y bg-transparent px-2 py-1 outline-none"
        readOnly={busy}
        rows={2}
        value={draft}
        maxLength={BRAIN_TELL_MAX}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key !== 'Enter' ||
            event.shiftKey ||
            event.ctrlKey ||
            event.metaKey ||
            ignoreShortcut(event.nativeEvent)
          )
            return
          event.preventDefault()
          if (canSend) send()
        }}
      />
      <div className="flex justify-end">
        <Button type="submit" variant="primary" size="sm" disabled={!canSend}>
          Send
        </Button>
      </div>
    </form>
  )
}

function AgentDialog({
  dialog,
  disabled,
  answer,
}: {
  dialog: ExtensionUIRequest
  disabled: boolean
  answer: (response: ExtensionUIResponse) => void
}) {
  const [text, setText] = useState(dialog.method === 'editor' ? (dialog.prefill ?? '') : '')
  const { id } = dialog
  const type = 'extension_ui_response' as const
  if (
    dialog.method !== 'select' &&
    dialog.method !== 'confirm' &&
    dialog.method !== 'input' &&
    dialog.method !== 'editor'
  )
    return null
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend>{dialog.title}</legend>
      {dialog.method === 'select' &&
        dialog.options.map((value, i) => (
          <Button key={i} onClick={() => answer({ type, id, value })}>
            {value}
          </Button>
        ))}
      {dialog.method === 'confirm' && (
        <>
          <p>{dialog.message}</p>
          <Button onClick={() => answer({ type, id, confirmed: true })}>Confirm</Button>
          <Button onClick={() => answer({ type, id, confirmed: false })}>Decline</Button>
        </>
      )}
      {(dialog.method === 'input' || dialog.method === 'editor') && (
        <>
          <textarea
            aria-label={dialog.title}
            maxLength={8000}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <Button onClick={() => answer({ type, id, value: text })}>Answer</Button>
        </>
      )}
      <Button onClick={() => answer({ type, id, cancelled: true })}>Cancel question</Button>
    </fieldset>
  )
}
