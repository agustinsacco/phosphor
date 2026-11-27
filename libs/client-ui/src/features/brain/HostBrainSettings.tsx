import { HostBrainAccess, HostBrainApprovals } from './HostBrainAccess'
import { useState } from 'react'
import { BRAIN_EMBEDDING_MODEL, type BrainPrefs } from '@shared/brain'
import { Button, Row, SectionTitle, Toggle } from '@/components/form'
import { promptText } from '@/stores/prompt'
import { useNavigation } from '@/navigation/Navigation'
import { useSettingsUiStore } from '@/features/settings/settingsUiStore'
import { BrainNeverRead } from '@/features/settings/tabs/BrainNeverRead'
import { HostBrainReader } from './HostBrainReader'
import { runHostSettingsAction } from './hostSettingsAction'
import {
  HOST_BRAIN_HINT,
  useHostBrain,
  useBrainRequest,
  useHostBrainSelection,
  type ReadyBrainSurface,
} from './useHostBrain'

export function HostBrainSettings({ hostId, label }: { hostId: string; label: string }) {
  const selected = useHostBrainSelection(hostId)
  return (
    <div key={selected.key}>
      <SectionTitle>Brain · {label}</SectionTitle>
      {selected.supported && selected.token && (
        <HostBrainAccess
          scope={{ hostId, connectionToken: selected.token }}
          rights={selected.access}
        />
      )}
      {selected.supported && selected.token && selected.access.length > 0 && (
        <HostBrainApprovals
          scope={{ hostId, connectionToken: selected.token }}
          rights={selected.access}
        />
      )}
      {selected.state === 'ready' && selected.token ? (
        <HostSettingsSession hostId={hostId} token={selected.token} access={selected.access} />
      ) : (
        <p role="status">
          {HOST_BRAIN_HINT[selected.state === 'ready' ? 'unavailable' : selected.state]}
        </p>
      )}
    </div>
  )
}

function HostSettingsSession({
  hostId,
  token,
  access,
}: {
  hostId: string
  token: string
  access: ReturnType<typeof useHostBrainSelection>['access']
}) {
  const brain = useHostBrain(hostId, token, access)
  return brain.status ? (
    <HostPreferences
      key={brain.status.generation}
      brain={{ ...brain, status: brain.status }}
      hostId={hostId}
    />
  ) : (
    <p role="status">
      {brain.error || 'Checking Brain…'}{' '}
      {brain.error && <Button onClick={() => void brain.refresh()}>Retry</Button>}
    </p>
  )
}

function HostPreferences({ brain, hostId }: { brain: ReadyBrainSurface; hostId: string }) {
  const { navigate } = useNavigation()
  const { prefs, supported } = brain.status
  const mayConfigure = supported && brain.access.includes('configure')
  const saved = useBrainRequest<'brain:prefs'>(
    brain,
    mayConfigure ? { method: 'brain:prefs', args: [] } : null,
  )
  const editable = mayConfigure && !!saved.data
  const { save, run, busy, error } = useHostSettingsActions(brain, saved.data)
  return (
    <>
      {!supported && <p role="status">Brain cannot run on this Host.</p>}
      {supported && !mayConfigure && (
        <p role="status">You can view, but not change, this Host’s Brain settings.</p>
      )}
      {saved.error && (
        <p role="status">
          Cannot load Brain preferences. <Button onClick={saved.retry}>Retry</Button>
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <Row
        title="Brain"
        description={
          <>
            Queued lanes are read on this Host and scrubbed excerpts may be sent to its configured
            provider. Turning Brain on downloads a local embedding model (
            <a href={BRAIN_EMBEDDING_MODEL.termsUrl} target="_blank" rel="noreferrer">
              terms
            </a>
            ).
          </>
        }
      >
        <Toggle
          on={prefs.enabled}
          disabled={!editable || busy}
          onChange={(enabled) => void save({ enabled })}
        />
      </Row>
      <Row title="Recall in lanes">
        <Toggle
          on={prefs.recall}
          disabled={!editable || busy}
          onChange={(recall) => void save({ recall })}
        />
      </Row>
      <Row title="Brain Agent checks new knowledge on its own">
        <Toggle
          on={prefs.agentAuto}
          disabled={!editable || busy}
          onChange={(agentAuto) => void save({ agentAuto })}
        />
      </Row>
      <HostBrainReader
        brain={brain}
        model={saved.data?.model ?? null}
        hostId={hostId}
        disabled={!editable || busy}
        save={(model) => void save({ model })}
      />
      <BrainNeverRead
        prefs={(saved.data ?? prefs).neverRead}
        saving={!editable || busy}
        onChange={(neverRead) => save({ neverRead })}
      />
      <HostSettingsStorage brain={brain} disabled={!editable || busy} run={run} />
      <Button
        onClick={() => {
          useSettingsUiStore.getState().setOpen(false)
          navigate({ to: 'page', page: 'brain', machine: hostId })
        }}
      >
        Open Brain
      </Button>
    </>
  )
}

function useHostSettingsActions(brain: ReadyBrainSurface, prefs?: BrainPrefs) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const expected = { generation: brain.status.generation, revision: brain.status.revision }
  const editable = brain.status.supported && brain.access.includes('configure') && !!prefs
  const act = async (operation: () => Promise<unknown>) => {
    if (busy || !editable) return false
    setBusy(true)
    setError('')
    try {
      return await runHostSettingsAction(operation, brain.refresh, () =>
        setError('The Host did not confirm that change. Refresh before trying again.'),
      )
    } finally {
      setBusy(false)
    }
  }
  const save = (patch: Partial<BrainPrefs>) =>
    act(() =>
      brain.invoke<'brain:setPrefs'>({
        method: 'brain:setPrefs',
        args: [{ ...prefs!, ...patch }],
        expected,
      }),
    )
  const run = (method: 'brain:download' | 'brain:removeModel' | 'brain:reset') =>
    act(() => brain.invoke({ method, args: [], expected }))
  return { save, run, busy, error }
}

function HostSettingsStorage({
  brain,
  disabled,
  run,
}: {
  brain: ReadyBrainSurface
  disabled: boolean
  run: (method: 'brain:download' | 'brain:removeModel' | 'brain:reset') => Promise<boolean>
}) {
  const { prefs, embedding } = brain.status
  const reset = async () => {
    const current = brain.capture()
    const value = await promptText({
      title: 'Reset Brain knowledge?',
      message:
        'This permanently deletes saved Brain knowledge on this Host. Type RESET to confirm.',
      placeholder: 'RESET',
      submitLabel: 'Reset knowledge',
    })
    if (value === 'RESET' && current()) await run('brain:reset')
  }
  return (
    <>
      <Row
        title="Embedding model"
        description={
          ['downloading', 'testing', 'verifying'].includes(embedding.phase)
            ? 'Preparing on this Host…'
            : embedding.phase === 'ready'
              ? 'Ready on this Host.'
              : 'Not ready on this Host.'
        }
      >
        {embedding.phase === 'error' && (
          <Button disabled={disabled} onClick={() => void run('brain:download')}>
            Retry download
          </Button>
        )}
        {!prefs.enabled && embedding.phase === 'ready' && (
          <Button disabled={disabled} onClick={() => void run('brain:removeModel')}>
            Remove model
          </Button>
        )}
      </Row>
      <Row title="Reset Brain knowledge">
        <Button variant="danger" disabled={disabled} onClick={() => void reset()}>
          Reset Brain knowledge
        </Button>
      </Row>
    </>
  )
}
