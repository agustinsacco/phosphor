import type { BrainEntity } from '@phosphor/shared/brain'
import type { Data } from './data'

interface EntitySource {
  entity: BrainEntity
  evidenceIds: string[]
}
function combine(sources: EntitySource[]): BrainEntity {
  const first = sources[0]!.entity
  return {
    ...first,
    aliases: [...new Set(sources.flatMap(({ entity }) => [entity.label, ...entity.aliases]))]
      .filter((alias) => alias !== first.label)
      .slice(0, 100),
  }
}
export function saveEntity(
  data: Data,
  sourceId: string,
  entity: BrainEntity,
  evidenceIds: string[],
): void {
  data.db
    .prepare(
      'INSERT OR IGNORE INTO entity_sources(entity_id,source_id,scope,recorded_at,value) VALUES (?,?,?,?,?)',
    )
    .run(entity.id, sourceId, entity.scope, data.now(), JSON.stringify({ entity, evidenceIds }))
  const sources = data.db
    .prepare('SELECT value FROM entity_sources WHERE entity_id=? ORDER BY recorded_at,seq')
    .all(entity.id)
    .map((row) => JSON.parse(String(row.value)) as EntitySource)
  data.put('entities', entity.id, entity.scope, combine(sources))
}
export function knownEntities(
  data: Data,
  scopes: string[],
  knownAt: number,
  limit: number,
  branch: string | null = null,
  entityIds?: string[],
): { entities: BrainEntity[]; truncated: boolean } {
  if (!scopes.length || entityIds?.length === 0) return { entities: [], truncated: false }
  const rows = data.db
    .prepare(
      `WITH eligible AS (SELECT * FROM entity_sources s WHERE scope IN (${scopes.map(() => '?').join(',')})
        AND recorded_at<=? ${entityIds ? `AND entity_id IN (${entityIds.map(() => '?').join(',')})` : ''}
        AND NOT EXISTS (SELECT 1 FROM json_each(s.value,'$.evidenceIds') ids LEFT JOIN documents e
          ON e.kind='evidence' AND e.id=ids.value WHERE e.id IS NULL OR json_type(e.value,'$.branch') IS NULL
          OR json_type(e.value,'$.branch') NOT IN ('null','text') OR (json_extract(e.value,'$.branch') IS NOT NULL
            AND (? IS NULL OR json_extract(e.value,'$.branch')!=?))))
      SELECT entity_id,value FROM eligible WHERE entity_id IN
        (SELECT entity_id FROM eligible GROUP BY entity_id ORDER BY entity_id LIMIT ?) ORDER BY entity_id,recorded_at,seq LIMIT 4001`,
    )
    .all(...scopes, knownAt, ...(entityIds ?? []), branch, branch, limit)
  const grouped = new Map<string, EntitySource[]>()
  for (const row of rows.slice(0, 4000)) {
    const id = String(row.entity_id)
    const source = JSON.parse(String(row.value)) as EntitySource
    const sources = grouped.get(id) ?? []
    sources.push(source)
    grouped.set(id, sources)
  }
  return { entities: [...grouped.values()].map(combine), truncated: rows.length > 4000 }
}
export function forgetEntitySources(data: Data, evidenceIds: Set<string>): void {
  const changed = new Set<string>()
  for (const row of data.db.prepare('SELECT seq,entity_id,value FROM entity_sources').all()) {
    const source = JSON.parse(String(row.value)) as EntitySource
    if (source.evidenceIds.some((id) => evidenceIds.has(id))) {
      changed.add(String(row.entity_id))
      data.db.prepare('DELETE FROM entity_sources WHERE seq=?').run(row.seq!)
    }
  }
  for (const id of changed) {
    const sources = data.db
      .prepare('SELECT value FROM entity_sources WHERE entity_id=? ORDER BY recorded_at,seq')
      .all(id)
      .map((row) => JSON.parse(String(row.value)) as EntitySource)
    if (sources.length) data.put('entities', id, sources[0]!.entity.scope, combine(sources))
    else data.remove('entities', id)
  }
}
