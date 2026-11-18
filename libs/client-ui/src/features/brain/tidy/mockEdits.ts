import type { BrainEntityKind } from '@shared/brain'
import type { BrainTidyOperation } from '@shared/brain-tidy'
import type { MockExplorer } from '../mockExplorer'

export interface MockEdit {
  kind: Extract<BrainTidyOperation['kind'], 'describe' | 'unname' | 'split'>
  summary: string
  apply: () => void
}

/** Describe, remove a name or split one invented record, as Desktop's entity edits do. */
export function mockEdit(explorer: MockExplorer, channel: string, args: unknown[]): MockEdit {
  const entity = explorer.entities.find((e) => e.id === args[0])
  if (!entity) throw new Error('Brain entity not found.')
  if (channel === 'brain:describe') {
    const description = (args[1] as string).trim()
    return {
      kind: 'describe',
      summary: `Changed the description of ${entity.label}`,
      apply: () => {
        entity.description = description
      },
    }
  }
  if (channel === 'brain:removeName') {
    const name = args[1] as string
    if (!entity.aliases.includes(name))
      throw new Error(`${entity.label} has no other name "${name}".`)
    return {
      kind: 'unname',
      summary: `Removed the name "${name}" from ${entity.label}`,
      apply: () => {
        entity.aliases = entity.aliases.filter((alias) => alias !== name)
      },
    }
  }
  const ids = args[1] as string[]
  const target = args[2] as { label: string; kind: BrainEntityKind }
  const own = explorer.details.filter((d) => d.memory.entityIds.includes(entity.id))
  if (ids.some((id) => !own.some((d) => d.memory.id === id)))
    throw new Error(`Every memory to split off must mention ${entity.label}.`)
  // Like Desktop: at least one current memory stays; a superseded one counts for nothing.
  const current = own.filter((d) => d.memory.state !== 'superseded')
  if (current.filter((d) => ids.includes(d.memory.id)).length >= current.length)
    throw new Error('Splitting off every memory is a rename; keep at least one.')
  return {
    kind: 'split',
    summary: `Split ${target.label.trim()} from ${entity.label}`,
    apply: () => {
      const id = `${entity.id}-split-${explorer.entities.length}`
      explorer.entities.push({
        id,
        label: target.label.trim(),
        kind: target.kind,
        aliases: [],
        description: '',
      })
      for (const detail of own.filter((d) => ids.includes(d.memory.id))) {
        const repoint = (value: string): string => (value === entity.id ? id : value)
        detail.memory.entityIds = detail.memory.entityIds.map(repoint)
        detail.memory.links = detail.memory.links.map((link) => ({
          ...link,
          subjectId: repoint(link.subjectId),
          objectId: repoint(link.objectId),
        }))
      }
    },
  }
}
