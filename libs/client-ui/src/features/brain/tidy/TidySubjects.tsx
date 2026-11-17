import { formatCount } from '@/lib/format'
import type { BrainTidySubjectDetail } from '@shared/brain-tidy'
import { BRAIN_PREDICATE_LABELS } from '@shared/brain'
import { Button } from '@/components/form'
import { MemoryQuotes, MemoryTags } from '../BrainMemory'
import type { BrainVisit } from '../explorer/trail'
import './tidy.css'

export function subjectVisit(subject: BrainTidySubjectDetail): BrainVisit {
  return subject.type === 'entity'
    ? { kind: 'entity', id: subject.value.entity.id, label: subject.value.entity.label }
    : { kind: 'memory', id: subject.value.memory.id, label: subject.value.memory.summary }
}
export function TidySubjects({
  subjects,
  onVisit,
  action,
}: {
  subjects: BrainTidySubjectDetail[]
  onVisit: (visit: BrainVisit) => void
  action?: (id: string) => React.ReactNode
}): React.JSX.Element {
  return (
    <div className="tidy-comparison">
      <div className="tidy-subjects">
        {subjects.map((subject) => {
          const visit = subjectVisit(subject)
          return (
            <article
              key={visit.id}
              aria-label={visit.label}
              className="border-border min-w-0 space-y-3 rounded border p-3"
            >
              <h3 className="text-lg font-medium">{visit.label}</h3>
              {subject.type === 'entity' ? (
                <EntitySubject value={subject.value} />
              ) : (
                <>
                  <MemoryTags memory={subject.value.memory} />
                  <p className="text-text-secondary text-sm">
                    Project: {subject.value.memory.scope || 'All projects'} · Branch:{' '}
                    {subject.value.memory.branch ?? 'All branches'}
                  </p>
                  <p className="text-text-secondary text-sm">
                    Said {new Date(subject.value.memory.observedAt).toLocaleDateString()} · Learned{' '}
                    {new Date(subject.value.memory.recordedAt).toLocaleDateString()}
                  </p>
                  <MemoryQuotes quotes={subject.value.quotes} />
                </>
              )}
              <Button size="sm" onClick={() => onVisit(visit)}>
                View in Knowledge
              </Button>
              {action?.(visit.id)}
            </article>
          )
        })}
      </div>
    </div>
  )
}
function EntitySubject({
  value,
}: {
  value: Extract<BrainTidySubjectDetail, { type: 'entity' }>['value']
}): React.JSX.Element {
  const { entity, groups, sources } = value
  return (
    <>
      <p className="text-text-secondary text-sm">
        {entity.kind} · {formatCount(entity.memories, 'memory', 'memories')}
      </p>
      <p>{entity.description || 'No description'}</p>
      <p className="text-text-secondary text-sm">
        Other names: {entity.aliases.join(', ') || 'None'}
      </p>
      <ul className="text-sm">
        {groups.flatMap((g) =>
          g.items.slice(0, 5).map((item) => (
            <li key={item.link.id}>
              {BRAIN_PREDICATE_LABELS[g.predicate][g.direction]} {item.entity.label}
            </li>
          )),
        )}
      </ul>
      <p className="text-text-secondary text-sm">
        Source lanes: {sources.map((s) => s.title).join(', ') || 'None'}
      </p>
    </>
  )
}
