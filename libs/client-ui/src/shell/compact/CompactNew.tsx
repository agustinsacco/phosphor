import { useRef, useState } from 'react'
import { ComposerField } from '@/features/chat/composer/ComposerField'
import { RemoteModelPicker, useRemoteModel } from '@/features/machines/RemoteModelPicker'
import { startRemoteChat } from '@/features/home/startRemoteChat'
import { remoteBranchName } from '@/features/home/remoteBranchName'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { homeDraftKey, useDraftsStore } from '@/stores/drafts'
import { useHomeSubmissionsStore } from '@/stores/homeSubmissions'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { Button } from '@/components/form'

export function CompactNew({ hostId }: { hostId: string }): React.JSX.Element {
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const selection = useRemoteModel(hostId)
  const [repositoryId, setRepositoryId] = useState('')
  const repository = repositoryId || host?.repositories[0]?.id || ''
  const [isolate, setIsolate] = useState(true)
  const draftKey = homeDraftKey(`host:${hostId}/machine`)
  const text = useDraftsStore((s) => s.drafts[draftKey]?.text ?? '')
  const busy = useHomeSubmissionsStore((s) => !!s.pending[draftKey])
  const field = useRef<HTMLTextAreaElement>(null)
  const [error, setError] = useState('')
  const ready = host?.state === 'ready' && host.capabilities.includes('sessions.control')
  async function send(): Promise<void> {
    if (
      !ready ||
      !text.trim() ||
      !repository ||
      !selection.model ||
      !useHomeSubmissionsStore.getState().begin(draftKey)
    )
      return
    const revision = useDraftsStore.getState().revisions[draftKey]
    setError('')
    try {
      await startRemoteChat(
        hostId,
        {
          repositoryId: repository,
          model: selection.model.id,
          provider: selection.model.provider,
          thinkingLevel: selection.thinking,
          ...(isolate ? { worktree: { branch: remoteBranchName(text), fresh: true } } : {}),
        },
        text.trim(),
        [],
        () => {
          if (useDraftsStore.getState().revisions[draftKey] === revision)
            useDraftsStore.getState().clear(draftKey)
        },
      )
    } catch {
      const message =
        'The Host could not confirm this. Check the lane before retrying. Your draft is kept.'
      setError(message)
      useExtensionUiStore.getState().pushToast(message, 'warning')
    } finally {
      useHomeSubmissionsStore.getState().finish(draftKey)
    }
  }
  return (
    <section className="compact-list" aria-label="New lane">
      <h1>New lane</h1>
      {!ready && (
        <p role="status">Connect this machine with session control before creating a lane.</p>
      )}
      <label>
        Repository
        <select
          aria-label="Repository"
          value={repository}
          onChange={(event) => setRepositoryId(event.target.value)}
          disabled={busy || !ready}
        >
          {!host?.repositories.length && <option value="">No repositories available</option>}
          {host?.repositories.map((repository) => (
            <option key={repository.id} value={repository.id}>
              {repository.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-3">
        <input
          type="checkbox"
          checked={isolate}
          disabled={busy}
          onChange={(event) => setIsolate(event.target.checked)}
        />
        Isolate in a new worktree
      </label>
      <RemoteModelPicker selection={selection} />
      <div className="bg-surface border-border rounded-xl border p-3">
        <ComposerField
          value={text}
          onChange={(value) => useDraftsStore.getState().setText(draftKey, value)}
          onSubmit={() => void send()}
          onPasteFiles={() => setError('Attach files after the lane opens.')}
          placeholder="Describe a task…"
          textareaRef={field}
          autocomplete={false}
        />
        <Button
          variant="primary"
          disabled={!ready || busy || !text.trim() || !selection.model || !repository}
          onClick={() => void send()}
        >
          {busy ? 'Starting…' : 'Start lane'}
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
      <p className="text-text-secondary">
        Starting a lane explicitly takes control. Reading an existing lane does not.
      </p>
    </section>
  )
}
