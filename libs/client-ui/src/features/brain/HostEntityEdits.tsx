import { useState } from 'react'
import type { BrainEntityView } from '@shared/brain'
import { SplitChoice } from './HostEntitySplit'
import type { HostBrainRequest } from '@shared/host-brain-request'
import { Button } from '@/components/form'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
import { useBrainRequest, type ReadyBrainSurface } from './useHostBrain'

export function HostEntityEdits({
  brain,
  view,
  visit,
}: {
  brain: ReadyBrainSurface
  view: BrainEntityView
  visit: (id: string) => void
}) {
  const [edit, setEdit] = useState<Edit | null>(null)
  const [problem, setProblem] = useState(false)
  const [busy, setBusy] = useState(false)
  const { generation, revision, ownerId } = brain.status
  const setOwner = async () => {
    if (busy) return
    setBusy(true)
    setProblem(false)
    try {
      await brain.invoke<'brain:setOwner'>({
        method: 'brain:setOwner',
        args: [ownerId === view.entity.id ? null : view.entity.id],
        expected: { generation, revision },
      })
      await brain.refresh()
    } catch {
      setProblem(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="xs" disabled={busy} onClick={() => void setOwner()}>
        {ownerId === view.entity.id ? 'Clear owner' : 'This is me'}
      </Button>
      <Button size="xs" onClick={() => setEdit('describe')}>
        Edit description…
      </Button>
      <Button
        size="xs"
        disabled={!view.entity.aliases.length}
        onClick={() => setEdit('removeName')}
      >
        Remove a name…
      </Button>
      <Button size="xs" onClick={() => setEdit('split')}>
        Split…
      </Button>
      <Button size="xs" onClick={() => setEdit('merge')}>
        Merge…
      </Button>
      {problem && <p role="alert">The Host did not confirm the owner change.</p>}
      {edit && (
        <EntityEdit
          brain={brain}
          view={view}
          edit={edit}
          visit={visit}
          close={() => setEdit(null)}
        />
      )}
    </div>
  )
}

type Edit = 'describe' | 'removeName' | 'split' | 'merge'
type Edits = HostBrainRequest<'brain:describe' | 'brain:removeName' | 'brain:split' | 'brain:merge'>
const EDIT_TITLE: Record<Edit, string> = {
  describe: 'Edit description',
  removeName: 'Remove a name',
  split: 'Split record',
  merge: 'Merge records',
}

function EntityEdit({
  brain,
  view,
  edit,
  visit,
  close,
}: {
  brain: ReadyBrainSurface
  view: BrainEntityView
  edit: Edit
  visit: (id: string) => void
  close: () => void
}) {
  // A dialog edits the revision it opened, not the result of a later poll.
  const [expected] = useState(() => ({
    generation: brain.status.generation,
    revision: brain.status.revision,
  }))
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState(false)
  const { entity } = view
  const title = `${EDIT_TITLE[edit]} · ${entity.label}`
  const send = async (request: Edits, destination?: string) => {
    if (busy) return
    setBusy(true)
    setProblem(false)
    try {
      await brain.invoke(request)
      if (destination) visit(destination)
      await brain.refresh()
      close()
    } catch {
      setProblem(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <ModalOverlay onClose={close} closeOnBackdrop={!busy} closeOnEscape={!busy}>
      <div role="dialog" aria-modal="true" aria-label={title}>
        <ModalPanel
          title={title}
          width={530}
          footer={
            <Button disabled={busy} onClick={close}>
              Cancel
            </Button>
          }
        >
          <div className="max-h-[68vh] space-y-2 overflow-auto p-4">
            {problem && (
              <p role="alert">
                The Host did not confirm the edit. Close and refresh before trying again.
              </p>
            )}
            <EntityEditForm
              edit={edit}
              brain={brain}
              entity={entity}
              busy={busy}
              expected={expected}
              send={send}
            />
          </div>
        </ModalPanel>
      </div>
    </ModalOverlay>
  )
}

function EntityEditForm({
  edit,
  brain,
  entity,
  busy,
  expected,
  send,
}: {
  edit: Edit
  brain: ReadyBrainSurface
  entity: BrainEntityView['entity']
  busy: boolean
  expected: { generation: string; revision: number }
  send: (request: Edits, destination?: string) => Promise<void>
}) {
  const { revision } = expected
  return (
    <>
      {edit === 'describe' && (
        <EditText
          label="Description"
          initial={entity.description}
          max={160}
          disabled={busy}
          apply={(description) =>
            void send({
              method: 'brain:describe',
              args: [entity.id, description, revision],
              expected,
            })
          }
        />
      )}
      {edit === 'removeName' && (
        <AliasChoice
          aliases={entity.aliases}
          disabled={busy}
          apply={(alias) =>
            void send({
              method: 'brain:removeName',
              args: [entity.id, alias, revision],
              expected,
            })
          }
        />
      )}
      {edit === 'split' && (
        <SplitChoice
          brain={brain}
          entityId={entity.id}
          disabled={busy}
          apply={(memoryIds, label, kind) =>
            void send({
              method: 'brain:split',
              args: [entity.id, memoryIds, { label, kind }, revision],
              expected,
            })
          }
        />
      )}
      {edit === 'merge' && (
        <MergeChoice
          brain={brain}
          entityId={entity.id}
          disabled={busy}
          apply={(id) =>
            void send({ method: 'brain:merge', args: [entity.id, id, revision], expected }, id)
          }
        />
      )}
    </>
  )
}

function EditText({
  label,
  initial,
  max,
  disabled,
  apply,
}: {
  label: string
  initial: string
  max: number
  disabled: boolean
  apply: (value: string) => void
}) {
  const [draft, setDraft] = useState(initial)
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (draft.trim() && !disabled) apply(draft.trim())
      }}
    >
      <label>
        {label} <input value={draft} maxLength={max} onChange={(e) => setDraft(e.target.value)} />
      </label>{' '}
      <Button type="submit" disabled={disabled || !draft.trim()}>
        Save
      </Button>
    </form>
  )
}

function AliasChoice({
  aliases,
  disabled,
  apply,
}: {
  aliases: string[]
  disabled: boolean
  apply: (alias: string) => void
}) {
  const [alias, setAlias] = useState(aliases[0] ?? '')
  return (
    <>
      <select aria-label="Name to remove" value={alias} onChange={(e) => setAlias(e.target.value)}>
        {aliases.map((name) => (
          <option key={name}>{name}</option>
        ))}
      </select>{' '}
      <Button disabled={disabled || !alias} onClick={() => apply(alias)}>
        Remove name
      </Button>
    </>
  )
}

function MergeChoice({
  brain,
  entityId,
  disabled,
  apply,
}: {
  brain: ReadyBrainSurface
  entityId: string
  disabled: boolean
  apply: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const [target, setTarget] = useState('')
  const matches = useBrainRequest<'brain:find'>(
    brain,
    query ? { method: 'brain:find', args: [query, 12] } : null,
  )
  const choices = matches.data?.entities.filter((entity) => entity.id !== entityId) ?? []
  return (
    <>
      <EditText
        label="Find the record to keep"
        initial=""
        max={200}
        disabled={disabled}
        apply={(value) => {
          setTarget('')
          setQuery(value)
        }}
      />
      {matches.error && (
        <p role="status">
          Search was refused. <Button onClick={matches.retry}>Retry</Button>
        </p>
      )}
      <select
        aria-label="Record to keep"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
      >
        <option value="">Select a record</option>
        {choices.map((entity) => (
          <option key={entity.id} value={entity.id}>
            {entity.label}
          </option>
        ))}
      </select>{' '}
      <Button
        disabled={disabled || !choices.some(({ id }) => id === target)}
        onClick={() => apply(target)}
      >
        Merge into selected record
      </Button>
    </>
  )
}
