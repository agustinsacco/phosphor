import { useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { FileMentionSource } from '@/features/chat/composer/useFileMentions'
import { RemoteModelPicker } from '@/features/machines/RemoteModelPicker'
import { HostFolderBrowser } from '@/features/machines/HostFolderBrowser'
import { ChoiceMenu } from '@/components/ChoiceMenu'
import { FOLDER_CHIP_CLASS, FolderIcon } from '@/features/workspaces/folderChip'
import { homeDraftKey } from '@/stores/drafts'
import { connectingTo, hostPending, machineLabel } from '@/stores/remoteLanes'
import { machineReadGeneration } from '@/stores/machineReadGeneration'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { IsolateToggle } from './IsolateToggle'
import { StartComposer, type StartTarget } from './StartComposer'
import { useRemoteStart } from './useRemoteStart'

interface Props {
  hostId: string
  draftKey?: string
  textareaRef?: RefObject<HTMLTextAreaElement | null>
  machinePicker?: ReactNode
}

/**
 * A new Host or draft gets a fresh composer. A new connection to the same Host
 * does not: a flaky link reconnects every few seconds, and remounting the field
 * each time dropped focus (and the phone's keyboard) and lost image picks.
 */
export function RemoteStartView(props: Props): React.JSX.Element {
  return <RemoteStartComposer key={`${props.hostId}:${props.draftKey}`} {...props} />
}

function RemoteStartComposer({
  hostId,
  draftKey = homeDraftKey(`host:${hostId}/machine`),
  textareaRef,
  machinePicker,
}: Props): React.JSX.Element {
  const field = useRef<HTMLTextAreaElement>(null)
  const target = useHostStart(hostId, draftKey)
  return (
    <StartComposer
      target={target}
      textareaRef={textareaRef ?? field}
      machinePicker={
        machinePicker ?? <span className="start-composer-host">{machineLabel(hostId)}</span>
      }
    />
  )
}

/** A Host as a start target. No `/` or context sources until the Host offers them before a lane exists. */
function useHostStart(hostId: string, draftKey: string): StartTarget {
  const c = useRemoteStart(hostId, draftKey)
  // The model picker reads per-connection catalogues, so it alone restarts with one.
  const generation = useRemoteLanesStore(() => machineReadGeneration(hostId))
  // Until the Host answers, nothing typed could start a lane: the field waits and says why.
  const waiting = useRemoteLanesStore((s) => hostPending(s, hostId)) && !c.ready
  const files = useHostRepositoryFiles(
    hostId,
    c.ready && !!c.host?.capabilities.includes('workspaces.read') ? c.repositoryId : '',
  )
  return {
    text: c.text,
    setText: c.setText,
    attachments: c.attachments,
    setAttachments: c.setAttachments,
    remoteAttachments: true,
    files,
    slash: null,
    swarm: { enabled: c.swarm, onChange: c.setSwarm },
    modelPicker: <RemoteModelPicker key={generation} selection={c.selection} />,
    targets: <HostStartTargets hostId={hostId} controller={c} />,
    contextSources: null,
    busy: c.busy,
    canSubmit: c.canSend,
    submit: c.send,
    locked: !c.ready,
    waiting: waiting ? connectingTo(hostId, c.host?.state) : null,
    status: waiting
      ? null
      : !c.ready
        ? 'Connect this machine with session control before creating a lane.'
        : !c.repositoryId
          ? 'Choose or add a repository on this machine.'
          : null,
    warning: c.warning,
    setWarning: c.setWarning,
  }
}

/** The chosen repository's files for `@`, read from the Host; none without one. */
function useHostRepositoryFiles(hostId: string, repositoryId: string): FileMentionSource | null {
  return useMemo(
    () =>
      repositoryId
        ? {
            key: `host:${hostId}/repository:${repositoryId}`,
            list: () => window.phosphor.invoke('hosts:repositoryFiles', hostId, repositoryId),
          }
        : null,
    [hostId, repositoryId],
  )
}

function HostStartTargets({
  hostId,
  controller: c,
}: {
  hostId: string
  controller: ReturnType<typeof useRemoteStart>
}): React.JSX.Element {
  const [addingFolder, setAddingFolder] = useState(false)
  return (
    <>
      <ChoiceMenu
        escapeContainer
        label="Repository"
        value={c.repositoryId}
        placement="above"
        triggerClassName={FOLDER_CHIP_CLASS}
        choices={[
          ...(c.host?.repositories ?? []).map((repo) => ({
            value: repo.id,
            label: repo.name,
            disabled: c.busy,
          })),
          {
            value: '__add__',
            label: `Add folder on ${machineLabel(hostId)}…`,
            disabled: c.busy || !c.ready || !c.host?.capabilities.includes('workspaces.write'),
          },
        ]}
        onChange={(id) => {
          if (id === '__add__') setAddingFolder(true)
          else c.setRepository(id)
        }}
      >
        <FolderIcon />
        <span className="max-w-40 truncate">
          {c.host?.repositories.find((repo) => repo.id === c.repositoryId)?.name ??
            'Choose repository'}
        </span>
      </ChoiceMenu>
      <IsolateToggle checked={c.isolate} disabled={c.busy} />
      {addingFolder && (
        <HostFolderBrowser
          hostId={hostId}
          onClose={() => setAddingFolder(false)}
          onAdded={c.setRepository}
        />
      )}
    </>
  )
}
