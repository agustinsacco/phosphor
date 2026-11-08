import { BRAIN_EMBEDDING_MODEL, type BrainPrefs, type BrainStatus } from '@shared/brain'
import { Button, Row, SectionTitle, Toggle } from '@/components/form'
import { useBrain, useBrainSync } from '@/features/brain/useBrain'
import { formatBytes } from '@/lib/format'
import { useNavigation } from '@/navigation/Navigation'
import { usePlatform } from '@/platform/Platform'
import { useSettingsUiStore } from '../settingsUiStore'

export function BrainTab(): React.JSX.Element {
  useBrainSync()
  const { navigate } = useNavigation()
  const supported = usePlatform().localBrain
  const status = useBrain((s) => s.status)
  const saving = useBrain((s) => s.saving)
  if (!supported) return <></>
  if (!status)
    return (
      <div className="text-text-tertiary text-sm">
        Checking Brain…{' '}
        <Button
          onClick={() => {
            void useBrain.getState().refresh()
          }}
        >
          Retry
        </Button>
      </div>
    )
  const save = (patch: Partial<BrainPrefs>): void => {
    void useBrain.getState().setPrefs({ ...status.prefs, ...patch })
  }
  const open = (): void => {
    useSettingsUiStore.getState().setOpen(false)
    navigate({ to: 'page', page: 'brain' })
  }
  return (
    <div>
      <SectionTitle>Brain</SectionTitle>
      <BrainToggleRow status={status} saving={saving} save={save} />
      {status.prefs.enabled && (
        <>
          <Row
            title="Recall in lanes"
            description="Agents in every lane can look up what you approved when it helps. They get two tools, brain_search and brain_related, and a skill that says when to use them. New lanes pick this up."
          >
            <Toggle
              on={status.prefs.recall}
              disabled={saving}
              onChange={(recall) => save({ recall })}
            />
          </Row>
          <Row
            title="Review before saving"
            description="New memories wait in Brain until you approve them. Turn this off to save them as soon as extraction finishes."
          >
            <Toggle
              on={status.prefs.review}
              disabled={saving}
              onChange={(review) => save({ review })}
            />
          </Row>
          <Row
            title="Knowledge"
            description={
              status.counts.memories
                ? `${status.counts.memories} memories about ${status.counts.entities} things. Stored on this computer.`
                : 'Nothing yet. Right-click a lane and choose Queue for knowledge extraction.'
            }
          >
            <Button onClick={open}>Open Brain</Button>
          </Row>
        </>
      )}
      <BrainModelState />
    </div>
  )
}

function BrainModelState(): React.JSX.Element | null {
  const status = useBrain((s) => s.status)
  const saving = useBrain((s) => s.saving)
  if (!status) return null
  const { phase, receivedBytes, totalBytes, error } = status.embedding
  if (phase === 'downloading')
    return (
      <div className="mt-3 text-sm" role="status">
        <div className="text-text-secondary mb-1.5">
          Downloading EmbeddingGemma · {formatBytes(receivedBytes)} of {formatBytes(totalBytes)}
        </div>
        <div className="bg-bg-secondary h-1.5 overflow-hidden rounded-full">
          <div
            className="bg-accent h-full rounded-full"
            style={{
              width: `${Math.min(100, totalBytes ? (receivedBytes / totalBytes) * 100 : 0)}%`,
            }}
          />
        </div>
      </div>
    )
  if (phase === 'verifying' || phase === 'testing')
    return (
      <p role="status" className="text-text-secondary mt-3 text-sm">
        Checking EmbeddingGemma…
      </p>
    )
  if (phase === 'error')
    return (
      <div className="mt-3 flex items-center gap-3 text-sm">
        <span className="text-warning">{error}</span>
        <Button
          disabled={saving}
          onClick={() => {
            void useBrain.getState().download()
          }}
        >
          Retry
        </Button>
      </div>
    )
  if (phase !== 'ready') return null
  return status.prefs.enabled ? (
    <p role="status" className="text-text-secondary mt-3 text-sm">
      EmbeddingGemma is ready. Search runs on this computer.
    </p>
  ) : (
    <div className="text-text-secondary mt-3 flex items-center gap-3 text-sm">
      <p>
        EmbeddingGemma ({formatBytes(BRAIN_EMBEDDING_MODEL.downloadBytes)}) and your{' '}
        {status.counts.memories} memories are kept on this computer.
      </p>
      <Button
        disabled={saving}
        onClick={() => {
          void useBrain.getState().removeModel()
        }}
      >
        Remove model
      </Button>
    </div>
  )
}

function BrainToggleRow({
  status,
  saving,
  save,
}: {
  status: BrainStatus
  saving: boolean
  save: (patch: Partial<BrainPrefs>) => void
}): React.JSX.Element {
  return (
    <Row
      title="Brain"
      description={
        <>
          Learns from lanes you queue and lets agents recall what you approve. Each lane is read by
          a private copy of itself on its own model, which sends the conversation once more. Turning
          this on downloads EmbeddingGemma for search on this computer (
          <a
            className="text-accent underline"
            href={BRAIN_EMBEDDING_MODEL.termsUrl}
            target="_blank"
            rel="noreferrer"
          >
            Gemma Terms of Use
          </a>
          ). Turning it off keeps the model and your knowledge.
        </>
      }
    >
      <Toggle
        on={status.prefs.enabled}
        disabled={saving}
        onChange={(enabled) => save({ enabled })}
      />
    </Row>
  )
}
