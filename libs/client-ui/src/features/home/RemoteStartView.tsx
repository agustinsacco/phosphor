import { useRef, useState, type ReactNode, type RefObject } from 'react'
import { ComposerInput } from '@/features/chat/composer/ComposerInput'
import type { SlashMenu } from '@/features/chat/composer/useSlashMenu'
import { RemoteModelPicker } from '@/features/machines/RemoteModelPicker'
import { HostFolderBrowser } from '@/features/machines/HostFolderBrowser'
import { ChoiceMenu } from '@/components/ChoiceMenu'
import { SubmitIconButton } from '@/components/ComposerButtons'
import { homeDraftKey } from '@/stores/drafts'
import { machineLabel } from '@/stores/remoteLanes'
import { machineReadGeneration } from '@/stores/machineReadGeneration'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { IsolateToggle } from './IsolateToggle'
import { useRemoteStart } from './useRemoteStart'
import './remoteStart.css'

const NO_SLASH: SlashMenu = {
  query: null,
  matches: [],
  visible: false,
  activeIndex: 0,
  setActiveIndex: () => undefined,
  close: () => undefined,
  sync: () => undefined,
  handleKeyDown: () => false,
  pick: () => undefined,
}
interface Props {
  hostId: string
  draftKey?: string
  textareaRef?: RefObject<HTMLTextAreaElement | null>
  machinePicker?: ReactNode
}

/** Remount ephemeral file reads, warnings and pickers when the Host connection changes. */
export function RemoteStartView(props: Props): React.JSX.Element {
  const generation = useRemoteLanesStore(() => machineReadGeneration(props.hostId))
  return <RemoteStartComposer key={`${props.hostId}:${props.draftKey}:${generation}`} {...props} />
}

function RemoteStartComposer({
  hostId,
  draftKey = homeDraftKey(`host:${hostId}/machine`),
  textareaRef,
  machinePicker,
}: Props): React.JSX.Element {
  const field = useRef<HTMLTextAreaElement>(null)
  const c = useRemoteStart(hostId, draftKey)
  return (
    <section className="remote-start" aria-label="New lane">
      <h2 className="remote-start-title">New lane</h2>
      <ComposerInput
        remoteAttachments
        value={c.text}
        textareaRef={textareaRef ?? field}
        onChange={c.setText}
        onSubmit={() => void c.send()}
        placeholder="Describe a task or ask a question"
        rows={3}
        autocomplete={false}
        attachments={c.attachments}
        onAttachmentsChange={c.setAttachments}
        onWarning={c.setWarning}
        slash={NO_SLASH}
        swarm={{ enabled: false, onChange: () => undefined }}
        modelPicker={<RemoteModelPicker selection={c.selection} />}
        actions={
          <SubmitIconButton
            busy={c.busy}
            disabled={!c.canSend}
            onClick={() => void c.send()}
            label="Start lane"
          />
        }
      />
      <RemoteStartTargets hostId={hostId} controller={c} machinePicker={machinePicker} />
      <p className="remote-start-note" role="status">
        {c.selection.explanation}
      </p>
      {!c.ready && (
        <p role="status">Connect this machine with session control before creating a lane.</p>
      )}
      {!c.repositoryId && c.ready && (
        <p role="status">Choose or add a repository on this machine.</p>
      )}
      {c.warning && (
        <p role="alert" className="text-warning">
          {c.warning}
        </p>
      )}
      <p className="remote-start-note">
        Starting a lane explicitly takes control. Reading an existing lane does not.
      </p>
    </section>
  )
}

function RemoteStartTargets({
  hostId,
  controller: c,
  machinePicker,
}: {
  hostId: string
  controller: ReturnType<typeof useRemoteStart>
  machinePicker?: ReactNode
}): React.JSX.Element {
  const [addingFolder, setAddingFolder] = useState(false)
  return (
    <>
      <div className="remote-start-targets">
        {machinePicker ?? (
          <span className="remote-start-host" title={machineLabel(hostId)}>
            {machineLabel(hostId)}
          </span>
        )}
        <ChoiceMenu
          label="Repository"
          value={c.repositoryId}
          placement="above"
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
          <span className="truncate">
            {c.host?.repositories.find((repo) => repo.id === c.repositoryId)?.name ??
              'Choose repository'}
          </span>
        </ChoiceMenu>
        <IsolateToggle checked={c.isolate} disabled={c.busy} />
      </div>
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
