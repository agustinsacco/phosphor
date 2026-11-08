import { type Data, identifier } from './data'

/** Even an empty recall delivery permanently excludes a recipient from capture. */
export function excludedSource(data: Data, sessionId: string): boolean {
  if (
    data.get('deliveries', sessionId) ||
    data.tombstoned(identifier('processor-session', sessionId))
  )
    return true
  const filename = `${sessionId}.jsonl`,
    suffix = `/${filename}`,
    bareSuffix = `/${sessionId}`
  return !!data.db
    .prepare(
      `SELECT id FROM documents WHERE kind='jobs' AND
    (id=? OR json_extract(value,'$.sessionPath') IN (?,?) OR
      substr(json_extract(value,'$.sessionPath'),-length(?))=? OR
      substr(json_extract(value,'$.sessionPath'),-length(?))=?) LIMIT 1`,
    )
    .get(sessionId, sessionId, filename, suffix, suffix, bareSuffix, bareSuffix)
}
export function activeProcessor(data: Data, exceptId = ''): boolean {
  return !!data.db
    .prepare(
      `SELECT id FROM documents WHERE kind='jobs' AND id!=?
    AND json_extract(value,'$.state') IN ('queued','running') LIMIT 1`,
    )
    .get(exceptId)
}
