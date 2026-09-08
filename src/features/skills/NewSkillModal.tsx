import { useState } from 'react'
import type { SkillScope } from '@shared/skills'
import { validateSkillName, SKILL_DESCRIPTION_MAX } from '@shared/skills'
import { ModalOverlay } from '@/components/Modal'
import { Button, TextInput } from '@/components/form'

/**
 * Create-a-skill modal (Claude Desktop's shape: name, description, content).
 * **Draft** saves with `disable-model-invocation: true` — the skill exists
 * and answers `/skill:name`, but stays out of the system prompt until
 * published from its detail view. The name is validated live against the
 * Agent Skills rules so main never sees an invalid one.
 */
export function NewSkillModal({
  workspacePath,
  onClose,
  onCreated,
}: {
  workspacePath: string
  onClose: () => void
  onCreated: () => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [content, setContent] = useState('')
  const [scope, setScope] = useState<SkillScope>('user')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const nameError = name ? validateSkillName(name) : null
  const ready = !!name && !nameError && !!description.trim() && !busy

  const create = async (draft: boolean): Promise<void> => {
    setBusy(true)
    setFailure(null)
    try {
      await window.phosphor.invoke('skills:create', {
        scope,
        workspacePath,
        name,
        description: description.trim(),
        content: content.trim() || `# ${name}\n\nInstructions for the agent go here.`,
        draft,
      })
      onCreated()
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  return (
    <ModalOverlay onClose={onClose}>
      <div className="border-border bg-surface w-[560px] max-w-[92vw] rounded-xl border p-5 shadow-lg">
        <div className="text-xl font-semibold">Create a skill</div>
        <div className="pt-3">
          <div className="text-text-secondary pb-1 text-sm">Skill name</div>
          <TextInput
            size="sm"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="weekly-status-report"
            autoFocus
          />
          {nameError && <div className="text-danger pt-1 text-sm">{nameError}</div>}
        </div>
        <div className="pt-2">
          <div className="text-text-secondary pb-1 text-sm">
            Description — this is how the model decides when to use it
          </div>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={SKILL_DESCRIPTION_MAX}
            placeholder="Generate weekly status reports from recent work. Use when asked for updates or progress summaries."
            className="border-border bg-bg focus:border-border-strong h-16 w-full resize-none rounded-md border px-2.5 py-1.5 text-base outline-none"
          />
        </div>
        <div className="pt-1">
          <div className="text-text-secondary pb-1 text-sm">Instructions</div>
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="Summarize my recent work in three sections: wins, blockers, and next steps…"
            className="border-border bg-bg focus:border-border-strong h-44 w-full resize-none rounded-md border px-2.5 py-1.5 font-mono text-sm outline-none"
          />
        </div>
        <div className="flex items-center gap-2 pt-1">
          <span className="text-text-secondary text-sm">Save to</span>
          <div className="border-border flex overflow-hidden rounded-md border">
            {(
              [
                ['user', 'Global (all workspaces)'],
                ['project', 'This project'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setScope(id)}
                className={
                  scope === id
                    ? 'bg-bg-secondary text-text cursor-pointer px-2.5 py-1 text-sm font-medium'
                    : 'text-text-secondary cursor-pointer px-2.5 py-1 text-sm'
                }
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {failure && <div className="text-danger pt-2 text-sm">{failure}</div>}
        <div className="flex items-center justify-between pt-4">
          <Button
            disabled={!ready}
            onClick={() => void create(true)}
            title="Saved but hidden from the model until published"
          >
            Draft
          </Button>
          <div className="flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={!ready} onClick={() => void create(false)}>
              Create
            </Button>
          </div>
        </div>
      </div>
    </ModalOverlay>
  )
}
