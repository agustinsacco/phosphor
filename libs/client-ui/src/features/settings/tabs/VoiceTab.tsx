import { useEffect } from 'react'
import { ipcErrorText } from '@shared/errors'
import { VOICE_MODELS, type VoicePrefs, type VoiceStatus } from '@shared/voice'
import { Button, Row, SectionTitle, Toggle } from '@/components/form'
import { formatBytes } from '@/lib/format'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useVoiceStore } from '@/stores/voice'

/**
 * Settings → Voice: dictation with a local speech model. Turning it on
 * downloads the selected model; turning it off deletes it. Main owns both
 * (`electron/voice/`); this tab only shows what it reports.
 */
export function VoiceTab(): React.JSX.Element {
  useEffect(() => useVoiceStore.getState().subscribe(), [])
  const status = useVoiceStore((s) => s.status)

  if (!status) return <div className="text-text-tertiary text-sm">Checking voice input…</div>
  const save = (patch: Partial<VoicePrefs>): void => {
    void useVoiceStore
      .getState()
      .setPrefs({ ...status.prefs, ...patch })
      .catch((error: unknown) =>
        useExtensionUiStore.getState().pushToast(ipcErrorText(error), 'error'),
      )
  }

  return (
    <div>
      <SectionTitle>Voice</SectionTitle>
      <Row
        title="Voice input"
        description="Adds a microphone to the composer: click it, talk, click again and the text appears at the caret. Speech is transcribed on this computer, and audio never leaves it. Turning this on downloads the model; turning it off deletes it."
      >
        <Toggle on={status.prefs.enabled} onChange={(enabled) => save({ enabled })} />
      </Row>
      <Row
        title="Model"
        description="Moonshine, run locally. Both sizes understand English only. Switching downloads the new model and deletes the old one."
      >
        <select
          aria-label="Model"
          value={status.prefs.model}
          onChange={(e) => save({ model: e.target.value as VoicePrefs['model'] })}
          className="border-border bg-surface text-text rounded-lg border px-2.5 py-1.5 text-base outline-none"
        >
          {VOICE_MODELS.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label} · {formatBytes(model.downloadBytes)}
            </option>
          ))}
        </select>
      </Row>
      <ModelState status={status} onRetry={() => save({})} />
    </div>
  )
}

function ModelState({
  status,
  onRetry,
}: {
  status: VoiceStatus
  onRetry: () => void
}): React.JSX.Element | null {
  const model = VOICE_MODELS.find((m) => m.id === status.prefs.model)
  if (status.phase === 'off') return null
  if (status.phase === 'error') {
    return (
      <div className="mt-3 flex items-center gap-3 text-sm">
        <span className="text-warning min-w-0 flex-1">{status.error}</span>
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    )
  }
  if (status.phase === 'downloading') {
    const percent = status.totalBytes ? (status.receivedBytes / status.totalBytes) * 100 : 0
    return (
      <div className="mt-3 text-sm" role="status">
        <div className="text-text-secondary mb-1.5">
          Downloading {model?.label} · {formatBytes(status.receivedBytes)} of{' '}
          {formatBytes(status.totalBytes)}
        </div>
        <div className="bg-bg-secondary h-1.5 overflow-hidden rounded-full">
          <div className="bg-accent h-full rounded-full" style={{ width: `${percent}%` }} />
        </div>
      </div>
    )
  }
  return (
    <div className="text-text-secondary mt-3 text-sm" role="status">
      {model?.label} is ready. {model?.detail}
    </div>
  )
}
