import { useState } from 'react'
import type { BrainEvidence, BrainSnapshot } from '@shared/brain'
import { Button } from '@/components/form'
import { BrainEvidenceRecord } from './BrainEvidenceRecord'
import { BrainForgetEvidence } from './BrainForgetEvidence'
import { useEvidencePage } from './useEvidencePage'
import type { BrainAction } from './useBrain'

type Props = { snapshot: BrainSnapshot; busy: boolean; act: BrainAction }
export function BrainCapturedEvidence({ snapshot, busy, act }: Props): React.JSX.Element {
  const [chosenScope, setScope] = useState('')
  const [notice, setNotice] = useState('')
  const scope = snapshot.prefs.workspaces.includes(chosenScope)
    ? chosenScope
    : (snapshot.prefs.workspaces[0] ?? '')
  return (
    <section className="brain-card" aria-label="Captured evidence">
      <h2>Captured evidence · including uncited sources</h2>
      <p>
        Inspect or forget sources before processing. Pages are sorted by ID, not by the next
        processing batch.
      </p>
      {notice && <p role="status">{notice}</p>}
      <label className="brain-field">
        Evidence workspace
        <select
          value={scope}
          disabled={busy}
          onChange={(e) => {
            setScope(e.target.value)
            setNotice('')
          }}
        >
          <option value="">Select workspace</option>
          {snapshot.prefs.workspaces.map((path) => (
            <option key={path}>{path}</option>
          ))}
        </select>
      </label>
      {snapshot.prefs.enabled && scope ? (
        <EvidenceBrowser
          key={scope}
          scope={scope}
          busy={busy}
          act={act}
          onForgot={setNotice}
          revision={`${snapshot.policyEpoch}:${snapshot.counts.evidence}`}
        />
      ) : (
        <p>Enable Brain and enroll a workspace to inspect retained sources.</p>
      )}
    </section>
  )
}

function EvidenceBrowser({
  scope,
  revision,
  busy,
  act,
  onForgot,
}: {
  scope: string
  revision: string
  busy: boolean
  act: BrainAction
  onForgot: (summary: string) => void
}): React.JSX.Element {
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined])
  const [selected, setSelected] = useState('')
  const { page, error, reload } = useEvidencePage(scope, cursors.at(-1), revision)
  const item = page?.items.find((entry) => entry.id === selected)
  return (
    <>
      {error && <p role="alert">{error}</p>}
      {!page && !error && <p role="status">Loading captured evidence…</p>}
      <EvidencePageControls
        busy={busy}
        cursors={cursors}
        nextCursor={page?.nextCursor}
        error={error}
        reload={reload}
        onPage={(next) => {
          setSelected('')
          setCursors(next)
        }}
      />
      {page && (
        <label className="brain-field">
          Captured evidence item
          <select
            aria-label="Captured evidence item"
            value={item?.id ?? ''}
            disabled={busy}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">Select evidence</option>
            {page.items.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label} · {new Date(entry.observedAt).toLocaleString()} · {entry.id}
              </option>
            ))}
          </select>
        </label>
      )}
      {page && !page.items.length && <p>No captured evidence on this page.</p>}
      <p>Up to 50 sources per page. Refresh the first page to include newly captured IDs.</p>
      {item && (
        <CapturedSource
          key={`${item.id}:${revision}`}
          id={item.id}
          busy={busy}
          act={act}
          onForgot={(summary) => {
            setSelected('')
            onForgot(summary)
          }}
        />
      )}
    </>
  )
}

function EvidencePageControls({
  busy,
  cursors,
  nextCursor,
  error,
  reload,
  onPage,
}: {
  busy: boolean
  cursors: (string | undefined)[]
  nextCursor: string | null | undefined
  error: string
  reload: () => void
  onPage: (cursors: (string | undefined)[]) => void
}): React.JSX.Element {
  return (
    <div className="brain-actions">
      <Button
        disabled={busy}
        onClick={() => {
          onPage([undefined])
          reload()
        }}
      >
        Refresh evidence list
      </Button>
      {error && (
        <Button disabled={busy} onClick={reload}>
          Retry evidence load
        </Button>
      )}
      <Button disabled={busy || cursors.length < 2} onClick={() => onPage(cursors.slice(0, -1))}>
        Previous evidence page
      </Button>
      <Button
        disabled={busy || !nextCursor}
        onClick={() => {
          if (nextCursor) onPage([...cursors, nextCursor])
        }}
      >
        Next evidence page
      </Button>
    </div>
  )
}

function CapturedSource({
  id,
  busy,
  act,
  onForgot,
}: {
  id: string
  busy: boolean
  act: BrainAction
  onForgot: (summary: string) => void
}): React.JSX.Element {
  const [original, setOriginal] = useState<BrainEvidence>()
  const [forgetting, setForgetting] = useState(false)
  return (
    <>
      <div className="brain-actions">
        <Button
          disabled={busy}
          onClick={() => {
            void act(async () => setOriginal(await window.phosphor.invoke('brain:read', id)))
          }}
        >
          Read captured evidence
        </Button>
        <Button disabled={busy || !original} onClick={() => setForgetting(true)}>
          Forget captured evidence…
        </Button>
      </div>
      {original && <BrainEvidenceRecord evidence={original} />}
      {forgetting && (
        <BrainForgetEvidence
          ids={[id]}
          label="captured evidence"
          busy={busy}
          act={act}
          onDone={() => setForgetting(false)}
          onForgot={onForgot}
        />
      )}
    </>
  )
}
