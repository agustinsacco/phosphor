import { useEffect, useState } from 'react'
import { BRAIN_TELL_MAX } from '@shared/brain'
import type { HostBrainLanePage } from '@shared/host-brain'
import type { ExtensionUIRequest, ExtensionUIResponse } from '@shared/rpc'
import { Button } from '@/components/form'
import { useBrainRequest, type ReadyBrainSurface } from './useHostBrain'

export function HostBrainAgent({ brain }: { brain: ReadyBrainSurface }): React.JSX.Element {
  const latest = useBrainRequest<'brain:laneShow'>(brain, { method: 'brain:laneShow', args: [] })
  const [older, setOlder] = useState<HostBrainLanePage[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const page = latest.data
  const retry = latest.retry
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden && !busy) retry()
    }, 2000)
    return () => window.clearInterval(timer)
  }, [busy, retry])
  const cursor = older.at(0)?.next ?? (older.length ? null : page?.next)
  const act = async (operation: () => Promise<unknown>, refresh = true) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await operation()
    } catch {
      setError('The Host did not confirm that action. Check Brain Agent before trying again.')
    } finally {
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
    <section aria-label="Brain Agent" className="space-y-3">
      <h2>Brain Agent</h2>
      {error && <p role="alert">{error}</p>}
      <Button size="xs" onClick={latest.retry}>
        Refresh conversation
      </Button>
      {!page ? (
        <p role="status">
          {latest.error ? 'The Host refused the conversation.' : 'Loading conversation…'}
        </p>
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
                  setOlder((pages) => [next, ...pages].slice(0, 4))
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

function AgentTranscript({ entries }: { entries: HostBrainLanePage['entries'] }) {
  return (
    <ol aria-label="Transcript" className="space-y-2">
      {entries.map((entry) => (
        <li key={entry.id}>
          <strong>{entry.role === 'user' ? 'You' : 'Brain Agent'}</strong>
          <p className="whitespace-pre-wrap break-words">{entry.text}</p>
        </li>
      ))}
    </ol>
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
  return (
    <>
      <p role="status">
        {page.running ? 'Brain Agent is responding.' : 'Brain Agent is idle.'}
        {page.controller && (held ? ' You have control.' : ' Another client has control.')}
      </p>
      {!held && (page.controller || page.dialogs.length > 0) && (
        <Button
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
      <AgentDialogs page={page} brain={brain} disabled={!held || busy} act={act} />
      {!page.messaging && (
        <p role="note">
          This Host can’t run messages to Brain Agent yet. It shows the saved conversation, and
          Defrag still runs.
        </p>
      )}
      <AgentComposer
        disabled={busy || !page.messaging || (!!page.controller && !held)}
        messaging={page.messaging}
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
  disabled,
  messaging,
  draft,
  setDraft,
  send,
}: {
  disabled: boolean
  /** Whether the Host can run a message at all; typing waits for nothing else. */
  messaging: boolean
  draft: string
  setDraft: (value: string) => void
  send: () => void
}) {
  return (
    <form
      aria-label="Brain Agent composer"
      onSubmit={(event) => {
        event.preventDefault()
        if (!disabled && draft.trim()) send()
      }}
    >
      <textarea
        aria-label="Message for Brain Agent"
        disabled={!messaging}
        value={draft}
        maxLength={BRAIN_TELL_MAX}
        onChange={(event) => setDraft(event.target.value)}
      />{' '}
      <Button type="submit" disabled={disabled || !draft.trim()}>
        Send
      </Button>
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
