import { useCallback, useState } from 'react'
import {
  BRAIN_ENTITY_KINDS,
  type BrainEntityKind,
  type BrainEntityView,
  type BrainMemory,
} from '@shared/brain'
import type { BrainTidyMutation } from '@shared/brain-tidy'
import { ipcErrorText } from '@shared/errors'
import type { ContextMenuItem } from '@/components/ContextMenu'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
import { Button, Select, TextInput } from '@/components/form'
import { formatCount } from '@/lib/format'
import { mutateBrain, useBrain } from '../useBrain'
import { useBrainResource } from '../useBrainResource'
import { ENTITY_WORDS } from '../memoryLabels'
import { tidyChangeToast } from '../tidy/tidyActions'

export type EntityEdit = 'split' | 'removeName' | 'describe'

const DESCRIPTION_MAX = 160
/** `brain:split` takes a new name of 1 to 80 characters. */
const SPLIT_LABEL_MAX = 80

/** The card's edit menu: the three edits, then the full map. */
export function profileMenu(
  view: BrainEntityView,
  onEdit: (edit: EntityEdit) => void,
  onFullMap: () => void,
): ContextMenuItem[] {
  return [
    { label: 'Split…', onClick: () => onEdit('split') },
    {
      label: 'Remove a name…',
      disabled: !view.entity.aliases.length,
      hint: view.entity.aliases.length ? undefined : 'no other names',
      onClick: () => onEdit('removeName'),
    },
    { label: 'Edit description…', onClick: () => onEdit('describe') },
    { label: 'Show in the whole graph', onClick: onFullMap, separatorAbove: true },
  ]
}

/**
 * Send one edit at the revision the owner saw. Success toasts with Undo; a refusal comes back
 * as the sentence to show inline, never silence.
 */
async function sendEdit(
  run: (revision: number) => Promise<BrainTidyMutation>,
  done: string,
): Promise<string | null> {
  const revision = useBrain.getState().status?.revision ?? 0
  try {
    tidyChangeToast(await mutateBrain(() => run(revision)), done)
    return null
  } catch (cause) {
    await useBrain.getState().refresh()
    const now = useBrain.getState().status?.revision
    return now !== undefined && now !== revision
      ? 'Brain changed. Check this again.'
      : ipcErrorText(cause)
  }
}

export function EntityEditDialog({
  edit,
  view,
  onClose,
}: {
  edit: EntityEdit
  view: BrainEntityView
  onClose: () => void
}): React.JSX.Element {
  const saving = useBrain((s) => s.saving)
  const title = {
    split: `Split ${view.entity.label}`,
    removeName: `Remove a name from ${view.entity.label}`,
    describe: `Describe ${view.entity.label}`,
  }[edit]
  return (
    <ModalOverlay onClose={onClose} closeOnBackdrop={!saving} closeOnEscape={!saving}>
      <div role="dialog" aria-modal="true" aria-label={title}>
        <ModalPanel width={520} title={title}>
          {edit === 'split' && <SplitForm view={view} onDone={onClose} />}
          {edit === 'removeName' && <RemoveNameForm view={view} onDone={onClose} />}
          {edit === 'describe' && <DescribeForm view={view} onDone={onClose} />}
        </ModalPanel>
      </div>
    </ModalOverlay>
  )
}

function Footer({
  error,
  onCancel,
  children,
}: {
  error: string
  onCancel: () => void
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="border-border space-y-2 border-t px-4 py-2.5">
      {error && (
        <p role="alert" className="text-danger text-sm [overflow-wrap:anywhere]">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        {children}
      </div>
    </div>
  )
}

function DescribeForm({
  view,
  onDone,
}: {
  view: BrainEntityView
  onDone: () => void
}): React.JSX.Element {
  const saving = useBrain((s) => s.saving)
  const [text, setText] = useState(view.entity.description)
  const [error, setError] = useState('')
  const trimmed = text.trim()
  const save = async (): Promise<void> => {
    setError('')
    const refusal = await sendEdit(
      (revision) => window.phosphor.invoke('brain:describe', view.entity.id, trimmed, revision),
      `Changed the description of ${view.entity.label}`,
    )
    if (refusal) setError(refusal)
    else onDone()
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <div className="space-y-1 px-4 py-3">
        <TextInput
          aria-label="Description"
          value={text}
          maxLength={DESCRIPTION_MAX}
          className="w-full"
          onChange={(event) => setText(event.target.value)}
        />
        <p className="text-text-tertiary text-right text-sm tabular-nums">
          {text.length} / {DESCRIPTION_MAX}
        </p>
      </div>
      <Footer error={error} onCancel={onDone}>
        <Button
          type="submit"
          variant="primary"
          disabled={saving || !trimmed || trimmed === view.entity.description}
        >
          Save
        </Button>
      </Footer>
    </form>
  )
}

function RemoveNameForm({
  view,
  onDone,
}: {
  view: BrainEntityView
  onDone: () => void
}): React.JSX.Element {
  const saving = useBrain((s) => s.saving)
  const [error, setError] = useState('')
  const remove = async (name: string): Promise<void> => {
    setError('')
    const refusal = await sendEdit(
      (revision) => window.phosphor.invoke('brain:removeName', view.entity.id, name, revision),
      `Removed the name “${name}” from ${view.entity.label}`,
    )
    if (refusal) setError(refusal)
    else onDone()
  }
  return (
    <>
      <div className="space-y-2 px-4 py-3">
        <p className="text-text-secondary text-sm">
          The name stays in the memories that use it; Brain just stops matching it to{' '}
          {view.entity.label}. Its own name, {view.entity.label}, cannot be removed.
        </p>
        <ul aria-label="Other names" className="divide-border divide-y">
          {view.entity.aliases.map((name) => (
            <li key={name} className="flex items-center gap-2 py-1.5">
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{name}</span>
              <Button
                size="xs"
                disabled={saving}
                onClick={() => {
                  void remove(name)
                }}
              >
                Remove “{name}”
              </Button>
            </li>
          ))}
        </ul>
      </div>
      <Footer error={error} onCancel={onDone} />
    </>
  )
}

function SplitForm({
  view,
  onDone,
}: {
  view: BrainEntityView
  onDone: () => void
}): React.JSX.Element {
  const saving = useBrain((s) => s.saving)
  const { memories, more, error: loadError, retry } = useSplitMemories(view.entity.id)
  const [picked, setPicked] = useState<string[]>([])
  const [label, setLabel] = useState('')
  const [kind, setKind] = useState<BrainEntityKind>(view.entity.kind)
  const [error, setError] = useState('')
  const name = label.trim()
  const split = async (): Promise<void> => {
    setError('')
    const refusal = await sendEdit(
      (revision) =>
        window.phosphor.invoke(
          'brain:split',
          view.entity.id,
          picked,
          { label: name, kind },
          revision,
        ),
      `Split ${name} from ${view.entity.label}`,
    )
    if (refusal) setError(refusal)
    else onDone()
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void split()
      }}
    >
      <div className="space-y-3 px-4 py-3">
        <p className="text-text-secondary text-sm">
          Tick the memories that are about someone or something else. They move to a new record with
          their links; {view.entity.label} keeps the rest and its other names.
        </p>
        <SplitChecklist
          memories={memories}
          picked={picked}
          onPick={setPicked}
          more={more}
          error={loadError}
          retry={retry}
        />
        <SplitTarget label={label} onLabel={setLabel} kind={kind} onKind={setKind} />
      </div>
      <Footer error={error} onCancel={onDone}>
        <Button
          type="submit"
          variant="primary"
          disabled={saving || !picked.length || !name}
          tooltip={
            !picked.length ? 'Tick at least one memory' : !name ? 'Name the new record' : undefined
          }
        >
          {picked.length
            ? `Split off ${formatCount(picked.length, 'memory', 'memories')}`
            : 'Split off'}
        </Button>
      </Footer>
    </form>
  )
}

/** The new record: its name and kind. */
function SplitTarget({
  label,
  onLabel,
  kind,
  onKind,
}: {
  label: string
  onLabel: (label: string) => void
  kind: BrainEntityKind
  onKind: (kind: BrainEntityKind) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-2">
      <TextInput
        aria-label="New name"
        placeholder="New name"
        value={label}
        maxLength={SPLIT_LABEL_MAX}
        className="min-w-0 flex-1"
        onChange={(event) => onLabel(event.target.value)}
      />
      <Select
        label="Kind"
        value={kind}
        onChange={onKind}
        options={BRAIN_ENTITY_KINDS.map((value) => ({ value, label: ENTITY_WORDS[value] }))}
      />
    </div>
  )
}

function SplitChecklist({
  memories,
  picked,
  onPick,
  more,
  error,
  retry,
}: {
  memories: BrainMemory[] | null
  picked: string[]
  onPick: (ids: string[]) => void
  more: (() => void) | null
  error: string
  retry: () => void
}): React.JSX.Element {
  if (!memories)
    return (
      <p role="status" className="text-sm">
        {error || 'Loading memories…'}{' '}
        {error && (
          <Button size="xs" onClick={retry}>
            Retry
          </Button>
        )}
      </p>
    )
  return (
    <div className="border-border max-h-72 overflow-y-auto rounded-md border px-2">
      <ul aria-label="Memories to split off" className="divide-border divide-y">
        {memories.map((memory) => (
          <li key={memory.id} className="py-1.5">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={picked.includes(memory.id)}
                onChange={(event) =>
                  onPick(
                    event.target.checked
                      ? [...picked, memory.id]
                      : picked.filter((id) => id !== memory.id),
                  )
                }
              />
              <span className="min-w-0 [overflow-wrap:anywhere]">{memory.summary}</span>
            </label>
          </li>
        ))}
      </ul>
      {more && (
        <Button size="xs" className="my-1.5" onClick={more}>
          Show more memories
        </Button>
      )}
    </div>
  )
}

/** This entity's current memories, newest first, a page at a time. */
function useSplitMemories(id: string) {
  const [cursors, setCursors] = useState<(string | null)[]>([null])
  const load = useCallback(async () => {
    const pages = []
    for (const cursor of cursors)
      pages.push(await window.phosphor.invoke('brain:entityMemories', id, {}, cursor))
    return pages
  }, [id, cursors])
  const { data, error, retry } = useBrainResource(load)
  const next = data?.at(-1)?.next ?? null
  return {
    memories: data
      ? [...new Map(data.flatMap((p) => p.memories).map((m) => [m.id, m])).values()]
      : null,
    more:
      next && (data?.flatMap((p) => p.memories).length ?? 0) < 200
        ? () => setCursors((old) => [...old, next])
        : null,
    error,
    retry,
  }
}
