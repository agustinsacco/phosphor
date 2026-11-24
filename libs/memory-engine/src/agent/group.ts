/**
 * Brain Agent settles a read's group question: the parent is reused or created, and each member
 * gets a memory stating it is part of the parent, quoted as Brain Agent. One journal operation.
 */
import type { BrainTidySuggestionExtra } from '@phosphor/shared/brain-tidy'
import { all, one, run, type Context } from '../database'
import { adjustCount, createEntity, entity, recountEntities, survivingEntityId } from '../entities'
import { nextNumber, bumpKnowledgeRevision } from '../prefs'
import { fold } from '../text'
import { fingerprintMemories } from '../tidy/fingerprints'
import { journal } from '../tidy/journal'
import type { SuggestionRow } from '../tidy/suggestions'
import type { JournalNote } from './notes'

type Group = Extract<BrainTidySuggestionExtra, { kind: 'group' }>
function surviving(ctx: Context, id: string): string | null {
  try {
    return survivingEntityId(ctx, id)
  } catch {
    return null
  }
}
function parentOf(ctx: Context, parent: Group['parent']): string {
  const known = parent.entityId && surviving(ctx, parent.entityId)
  if (known) return known
  const named = all<{ id: string; kind: string }>(
    ctx,
    'SELECT e.id,e.kind FROM entity_names a JOIN entities e ON e.n=a.entity WHERE a.folded=? ORDER BY e.n',
    fold(parent.label),
  ).find((row) => row.kind === parent.kind)
  return (
    named?.id ??
    createEntity(ctx, {
      label: parent.label,
      kind: parent.kind,
      aliases: [],
      description: '',
      keys: [],
    })
  )
}
/** Where the group's memories live: the read's project, else a member's newest memory's. */
function scopeOf(ctx: Context, jobId: string, members: string[]): string {
  return (
    one<{ scope: string }>(ctx, 'SELECT scope FROM jobs WHERE id=?', jobId)?.scope ??
    one<{ scope: string }>(
      ctx,
      `SELECT m.scope FROM mentions a JOIN memories m ON m.n=a.memory JOIN entities e ON e.n=a.entity
      WHERE e.id IN (SELECT value FROM json_each(?)) ORDER BY m.observed_at DESC LIMIT 1`,
      JSON.stringify(members),
    )?.scope ??
    ''
  )
}
function insertPartOf(ctx: Context, member: string, parent: string, scope: string, entry: string) {
  const [m, p] = [member, parent].map(
    (id) => one<{ n: number }>(ctx, 'SELECT n FROM entities WHERE id=?', id)!.n,
  )
  const summary = `${entity(ctx, member)!.label} is part of ${entity(ctx, parent)!.label}.`
  const n = nextNumber(ctx, 'memories'),
    now = ctx.now()
  run(
    ctx,
    `INSERT INTO memories(n,id,summary,type,epistemic,scope,branch,valid_from,valid_to,observed_at,recorded_at,state,origin_session,origin_title,job_id)
    VALUES (?,?,?,'fact','reported',?,NULL,NULL,NULL,?,?,'active',NULL,NULL,NULL)`,
    n,
    ctx.id(),
    summary,
    scope,
    now,
    now,
  )
  run(ctx, 'INSERT INTO memory_words(rowid,summary) VALUES (?,?)', n, summary)
  run(ctx, 'INSERT INTO mentions VALUES (?,?),(?,?)', n, m!, n, p!)
  run(
    ctx,
    "INSERT INTO evidence(session_id,entry_id,role,label,observed_at,text) VALUES (NULL,?,'assistant','Brain Agent',?,?)",
    entry,
    now,
    summary,
  )
  const evidence = one<{ n: number }>(ctx, 'SELECT last_insert_rowid() AS n')!.n
  run(ctx, 'INSERT INTO citations VALUES (?,?,?)', n, evidence, summary)
  run(
    ctx,
    `INSERT INTO relations(memory,subject,predicate,object,live,observed_at,label,valid_from,valid_to,stated_by)
    VALUES (?,?,'part_of',?,1,?,'',NULL,NULL,'agent')`,
    n,
    m!,
    p!,
    now,
  )
  const relation = one<{ n: number }>(ctx, 'SELECT last_insert_rowid() AS n')!.n
  run(ctx, 'INSERT INTO relation_support VALUES (?,?,?)', relation, evidence, summary)
  adjustCount(ctx, 'memories', 1)
  return { memory: n, entities: [m!, p!] }
}
/** Caller owns the transaction and the suggestion's state. */
export function groupChange(ctx: Context, row: SuggestionRow, note: JournalNote): string {
  const group = (row.detail ? JSON.parse(row.detail) : null) as Group | null
  if (group?.kind !== 'group')
    throw new Error('This action does not apply to this Tidy suggestion.')
  const members = [...new Set(group.memberIds.flatMap((id) => surviving(ctx, id) ?? []))]
  if (!members.length) throw new Error('A subject of this suggestion is no longer available.')
  const entityMax = one<{ n: number }>(ctx, 'SELECT COALESCE(MAX(n),0) AS n FROM entities')!.n
  const selection = { entities: [] as number[], memories: [] as number[] }
  const id = ctx.id()
  const operation = journal(
    ctx,
    {
      id,
      kind: 'group',
      note,
      suggestionId: row.id,
      subjects: { type: 'entity', first: members[0]!, second: members.at(-1)! },
      selection,
      summary: `Grouped ${members.length} under ${group.parent.label}`,
    },
    () => {
      const parent = parentOf(ctx, group.parent)
      const scope = scopeOf(ctx, group.jobId, members)
      const touched = new Set<number>()
      for (const member of members.filter((m) => m !== parent)) {
        const made = insertPartOf(ctx, member, parent, scope, `group:${id}:${member}`)
        selection.memories.push(made.memory)
        for (const n of made.entities) touched.add(n)
      }
      selection.entities.push(
        ...all<{ n: number }>(ctx, 'SELECT n FROM entities WHERE n>?', entityMax).map((r) => r.n),
      )
      recountEntities(ctx, touched)
      fingerprintMemories(ctx, selection.memories)
    },
  )
  bumpKnowledgeRevision(ctx)
  return operation
}
