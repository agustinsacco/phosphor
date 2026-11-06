import { useEffect, useState } from 'react'
import { BRAIN_EMBEDDING_MODEL, type BrainPrefs, type BrainStatus } from '@shared/brain'
import { Button } from '@/components/form'
import type { BrainAction } from './useBrain'

export function BrainSettings({
  status,
  busy,
  act,
}: {
  status: BrainStatus
  busy: boolean
  act: BrainAction
}): React.JSX.Element {
  const [draft, setDraft] = useState<BrainPrefs>(status.snapshot.prefs)
  const { known, loadError, retryWorkspaces } = useWorkspaceOptions()
  const [consent, setConsent] = useState(false)
  const [retentionConfirmed, setRetentionConfirmed] = useState(false)
  const decreasesRetention = draft.retentionDays < status.snapshot.prefs.retentionDays
  const changeDraft = (prefs: BrainPrefs): void => {
    setDraft(prefs)
    setConsent(false)
  }
  const valid =
    (!decreasesRetention || retentionConfirmed) &&
    draft.retentionDays >= 1 &&
    draft.retentionDays <= 3650 &&
    Number.isInteger(draft.retentionDays) &&
    (!draft.enabled ||
      (!!draft.processor?.provider.trim() && !!draft.processor.id.trim() && consent))
  return (
    <section aria-label="Brain settings">
      <h2 className="font-semibold">Settings · explicit opt-in</h2>
      <p>
        Only newly captured evidence in enrolled workspaces is eligible. No private transcript
        import or connector ingestion.
      </p>
      <fieldset disabled={busy}>
        <EnablePrefs draft={draft} setDraft={changeDraft} />
        <WorkspaceEnrollment draft={draft} setDraft={changeDraft} known={known} act={act} />
        {loadError && (
          <p role="alert">
            Could not load saved workspaces: {loadError}{' '}
            <Button onClick={retryWorkspaces}>Retry workspaces</Button>
          </p>
        )}
        <ReasoningFields
          draft={draft}
          setDraft={changeDraft}
          consent={consent}
          setConsent={setConsent}
        />
        <RetentionFields
          draft={draft}
          setDraft={(prefs) => {
            setDraft(prefs)
            setRetentionConfirmed(false)
          }}
          decreasesRetention={decreasesRetention}
          confirmed={retentionConfirmed}
          setConfirmed={setRetentionConfirmed}
        />
        <Button
          disabled={!valid}
          onClick={() => {
            void act(() => window.phosphor.invoke('brain:setPrefs', draft))
          }}
        >
          Save Brain settings
        </Button>
      </fieldset>
      <EmbeddingSettings status={status} busy={busy} act={act} />
      <p>{status.notice}</p>
    </section>
  )
}

type DraftProps = { draft: BrainPrefs; setDraft: (prefs: BrainPrefs) => void }
function WorkspaceEnrollment({
  draft,
  setDraft,
  known,
  act,
}: DraftProps & { known: string[]; act: BrainAction }): React.JSX.Element {
  const paths = [...new Set([...known, ...draft.workspaces])]
  const [picked, setPicked] = useState<string | null>(null)
  return (
    <div className="brain-card">
      <h3>Enrolled workspaces</h3>
      {[...new Set([...paths, ...(picked ? [picked] : [])])].map((path) => (
        <label className="brain-field" key={path}>
          <span>
            <input
              type="checkbox"
              checked={draft.workspaces.includes(path)}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  workspaces: e.target.checked
                    ? [...draft.workspaces, path]
                    : draft.workspaces.filter((p) => p !== path),
                })
              }
            />{' '}
            {path}
          </span>
        </label>
      ))}
      <Button
        onClick={() => {
          void act(async () => {
            const folder = await window.phosphor.invoke('app:selectFolder')
            if (folder) setPicked(folder)
          })
        }}
      >
        Choose folder for enrollment
      </Button>
      <p>Choosing a folder does not enroll it. Check it and save to consent to future capture.</p>
    </div>
  )
}

function ReasoningFields({
  draft,
  setDraft,
  consent,
  setConsent,
}: DraftProps & { consent: boolean; setConsent: (v: boolean) => void }): React.JSX.Element {
  return (
    <div className="brain-card">
      <h3>Reasoning provider · separate from local embeddings</h3>
      <p>
        Manual Process sends enrolled evidence to the exact configured native Anthropic or OpenAI
        model, using its API key from the local app environment. Shared OAuth and CLI providers are
        unsupported. A remote provider receives transcript content. Local embeddings do not make
        remote reasoning private. No automatic model fallback.
      </p>
      <label className="brain-field">
        Exact provider
        <input
          value={draft.processor?.provider ?? ''}
          onChange={(e) =>
            setDraft({
              ...draft,
              processor: { provider: e.target.value, id: draft.processor?.id ?? '' },
            })
          }
        />
      </label>
      <label className="brain-field">
        Exact model ID
        <input
          value={draft.processor?.id ?? ''}
          onChange={(e) =>
            setDraft({
              ...draft,
              processor: { provider: draft.processor?.provider ?? '', id: e.target.value },
            })
          }
        />
      </label>
      <label>
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> I
        consent to capture and the disclosed reasoning-provider egress for these enrolled
        workspaces.
      </label>
    </div>
  )
}

function EmbeddingSettings({
  status,
  busy,
  act,
}: {
  status: BrainStatus
  busy: boolean
  act: BrainAction
}): React.JSX.Element {
  const [terms, setTerms] = useState(false)
  const [remove, setRemove] = useState(false)
  const model = status.embedding
  const transferring = ['downloading', 'verifying', 'testing'].includes(model.phase)
  return (
    <section className="brain-card" aria-label="Local embedding model">
      <h3>Local embedding model</h3>
      <p>
        {model.modelId} · {model.dimensions} dimensions · {model.phase}
      </p>
      <ModelDisclosure />
      {transferring && (
        <p role="status">
          {model.receivedBytes} / {model.totalBytes || 'unknown'} bytes · {model.phase}
        </p>
      )}
      {model.error && <p role="alert">{model.error}</p>}
      <label className="brain-field">
        <span>
          <input
            aria-label="Accept embedding model terms"
            type="checkbox"
            checked={terms}
            onChange={(e) => setTerms(e.target.checked)}
          />{' '}
          I have reviewed and accept the model terms and consent to this download.
        </span>
      </label>
      <div className="brain-actions">
        <Button
          disabled={
            busy ||
            !status.snapshot.prefs.enabled ||
            !terms ||
            transferring ||
            model.phase === 'ready' ||
            model.phase === 'unsupported'
          }
          onClick={() => {
            void act(() => window.phosphor.invoke('brain:download', true))
          }}
        >
          Download local embedding model
        </Button>
        <Button disabled={busy || transferring} onClick={() => setRemove(true)}>
          Remove downloaded model…
        </Button>
      </div>
      {remove && (
        <div role="group" aria-label="Confirm model removal">
          <p>
            Remove model files? Stored memory stays, but semantic search will be unavailable until
            another explicit download.
          </p>
          <Button onClick={() => setRemove(false)}>Keep model</Button>
          <Button
            disabled={busy}
            variant="danger"
            onClick={() => {
              void act(() => window.phosphor.invoke('brain:removeModel')).then((ok) => {
                if (ok) setRemove(false)
              })
            }}
          >
            Confirm remove model
          </Button>
        </div>
      )}
    </section>
  )
}

function EnablePrefs({ draft, setDraft }: DraftProps): React.JSX.Element {
  return (
    <>
      <label className="brain-field">
        <span>
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
          />{' '}
          Enable Brain
        </span>
      </label>
      <label className="brain-field">
        <span>
          <input
            type="checkbox"
            checked={draft.recall}
            onChange={(e) => setDraft({ ...draft, recall: e.target.checked })}
          />{' '}
          Allow automatic recall into enrolled sessions
        </span>
      </label>
      <p>
        Recall can deliver reviewed memory into sessions. Disabling stops capture, processing and
        recall, but preserves stored memory and model downloads.
      </p>
    </>
  )
}

function ModelDisclosure(): React.JSX.Element {
  return (
    <>
      <p>
        Embeddings run only on this computer. Download contacts the model distributor and transfers
        model files; it does not upload evidence. Review the model terms before downloading. The
        model is separate from Brain enablement and the reasoning provider.
      </p>
      <a href={BRAIN_EMBEDDING_MODEL.modelUrl} target="_blank" rel="noreferrer">
        Model card (opens distributor website)
      </a>
      <p>
        {BRAIN_EMBEDDING_MODEL.label} · download{' '}
        {BRAIN_EMBEDDING_MODEL.downloadBytes.toLocaleString()} bytes
      </p>
      <p>
        <a href={BRAIN_EMBEDDING_MODEL.termsUrl} target="_blank" rel="noreferrer">
          Gemma terms
        </a>{' '}
        ·{' '}
        <a href={BRAIN_EMBEDDING_MODEL.usePolicyUrl} target="_blank" rel="noreferrer">
          Prohibited-use policy
        </a>
      </p>
    </>
  )
}

function useWorkspaceOptions(): {
  known: string[]
  loadError: string
  retryWorkspaces: () => void
} {
  const [known, setKnown] = useState<string[]>([])
  const [loadError, setLoadError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let active = true
    window.phosphor
      .invoke('app:getPrefs')
      .then((prefs) => {
        if (active) {
          setKnown(prefs.recentWorkspaces.map((w) => w.path))
          setLoadError('')
        }
      })
      .catch((cause: unknown) => {
        if (active) setLoadError(String(cause))
      })
    return () => {
      active = false
    }
  }, [retry])
  return { known, loadError, retryWorkspaces: () => setRetry(retry + 1) }
}

function RetentionFields({
  draft,
  setDraft,
  decreasesRetention,
  confirmed,
  setConfirmed,
}: DraftProps & {
  decreasesRetention: boolean
  confirmed: boolean
  setConfirmed: (value: boolean) => void
}): React.JSX.Element {
  return (
    <>
      <label className="brain-field">
        Retention days (1–3650)
        <input
          type="number"
          min="1"
          max="3650"
          value={draft.retentionDays}
          onChange={(e) => setDraft({ ...draft, retentionDays: Number(e.target.value) })}
        />
      </label>
      <p>
        Retention is retained-since-capture expiry, not the age of the source event. Reducing it can
        remove retained evidence and dependent memory. Processor copies are queued for controlled
        cleanup; ordinary recipients, providers and backups may retain delivered copies. This is not
        universal erasure.
      </p>
      {decreasesRetention && (
        <label className="brain-field">
          <span>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />{' '}
            I confirm this retention decrease and understand the delivered-copy limitation.
          </span>
        </label>
      )}
    </>
  )
}
