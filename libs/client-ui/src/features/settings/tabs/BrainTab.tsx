import { BRAIN_EMBEDDING_MODEL, type BrainPrefs, type BrainStatus } from '@shared/brain'
import { Button, Row, SectionTitle, Toggle } from '@/components/form'
import { useBrain } from '@/features/brain/useBrain'
import { useBrainSync } from '@/features/brain/useBrainSync'
import { formatBytes, formatCount } from '@/lib/format'
import { useNavigation } from '@/navigation/Navigation'
import { usePlatform } from '@/platform/Platform'
import { promptText } from '@/stores/prompt'
import { useSettingsUiStore } from '../settingsUiStore'
import { BrainReaderModel } from './BrainReaderModel'
import { BrainNeverRead } from './BrainNeverRead'

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
    navigate({ to: 'page', page: 'brain', machine: 'local' })
  }
  return (
    <div>
      <SectionTitle>Brain</SectionTitle>
      <BrainToggleRow status={status} saving={saving} save={save} />
      {status.prefs.enabled && (
        <>
          <Row
            title="Recall in lanes"
            description="Agents in new lanes get brain_search to recall saved knowledge and brain_flag to suggest a correction for Brain Agent to review during Defrag, never to change Brain."
          >
            <Toggle
              on={status.prefs.recall}
              disabled={saving}
              onChange={(recall) => save({ recall })}
            />
          </Row>
          <Row
            title="Brain Agent checks new knowledge on its own"
            description="Reads save as soon as they finish. A minute after new knowledge settles, Brain Agent links people, groups what belongs together and settles repeats, at most 6 times a day. Every change is listed in What changed with Undo."
          >
            <Toggle
              on={status.prefs.agentAuto}
              disabled={saving}
              onChange={(agentAuto) => save({ agentAuto })}
            />
          </Row>
          <BrainReadingPrefs status={status} saving={saving} />
          <Row
            title="Knowledge"
            description={
              status.counts.memories
                ? `${formatCount(status.counts.memories, 'memory', 'memories')} about ${formatCount(status.counts.entities, 'thing')}. Stored on this computer.`
                : 'Nothing yet. Right-click a lane and choose Queue for knowledge extraction.'
            }
          >
            <Button onClick={open}>Open Brain</Button>
          </Row>
        </>
      )}
      <BrainModelState />
      <BrainReset saving={saving} />
    </div>
  )
}

function BrainReadingPrefs({
  status,
  saving,
}: {
  status: BrainStatus
  saving: boolean
}): React.JSX.Element {
  const save = (patch: Partial<BrainPrefs>) =>
    useBrain.getState().setPrefs({ ...status.prefs, ...patch })
  return (
    <>
      <BrainReaderModel
        model={status.prefs.model}
        saving={saving}
        onChange={(model) => {
          void save({ model })
        }}
      />
      <BrainNeverRead
        prefs={status.prefs.neverRead}
        saving={saving}
        onChange={(neverRead) => save({ neverRead })}
      />
    </>
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
        EmbeddingGemma ({formatBytes(BRAIN_EMBEDDING_MODEL.downloadBytes)})
        {status.counts.memories
          ? ` and your ${formatCount(status.counts.memories, 'memory', 'memories')} are kept`
          : ' is kept'}{' '}
        on this computer.
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
          Learns from lanes you queue and lets agents recall what Brain saves. Each queued lane is
          read in private windows with the chosen reader model, which can make several provider
          calls. Turning this on downloads EmbeddingGemma for search on this computer (
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

async function resetKnowledge(): Promise<void> {
  const answer = await promptText({
    title: 'Reset Brain knowledge?',
    message:
      'Deletes all memories, entities, jobs and extraction records. Keeps settings and the embedding model. This cannot be undone. Type RESET to confirm.',
    placeholder: 'RESET',
    submitLabel: 'Reset knowledge',
  })
  if (answer === 'RESET') await useBrain.getState().reset()
}

function BrainReset({ saving }: { saving: boolean }): React.JSX.Element {
  return (
    <Row
      title="Reset Brain knowledge"
      description="Deletes all memories, entities, jobs and extraction records. Keeps your settings and embedding model."
    >
      <Button
        variant="danger"
        disabled={saving}
        onClick={() => {
          void resetKnowledge()
        }}
      >
        Reset Brain knowledge
      </Button>
    </Row>
  )
}
