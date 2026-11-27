import { DEFAULT_SEARCH_OPTIONS } from '@phosphor/shared/text-search'
import { MAX_QUERY_LENGTH } from '@phosphor/shared/workspace-search'
import { looksBinary } from '@phosphor/shared/file-kinds'
import { parseFileParams } from '@phosphor/shared/host-protocol-files'
import { searchFiles, searchText } from '@phosphor/session-runtime/files/workspace-search'
import { guardedSearchRead, type ReadPorts } from './read'

export function parseSearch(params: unknown) {
  if (!params || typeof params !== 'object' || !('query' in params)) return null
  const { query, ...rest } = params
  const target = parseFileParams('files.list', rest)
  return target?.laneId &&
    typeof query === 'string' &&
    query.length > 0 &&
    query.length <= MAX_QUERY_LENGTH
    ? { laneId: target.laneId, query }
    : null
}

export interface SearchRows {
  rows: { path: string; line: number; snippet: string }[]
  capped: boolean
}

export async function searchLaneFiles(
  root: string,
  query: string,
  files: string[],
  ports: ReadPorts,
  signal?: AbortSignal,
): Promise<SearchRows> {
  const rows: SearchRows['rows'] = []
  const result = await searchFiles(
    { root, files: files.sort(), query: { ...DEFAULT_SEARCH_OPTIONS, text: query } },
    (batch) => {
      for (const { path, matches } of batch.files)
        for (const { line, preview } of matches)
          rows.push({ path, line, snippet: Buffer.from(preview).toString() })
    },
    {
      signal,
      async read(path) {
        const bytes = await guardedSearchRead(root, path, ports).catch(() => null)
        return !bytes || looksBinary(bytes)
          ? { kind: 'skipped' }
          : searchText(bytes.toString('utf8'))
      },
    },
  )
  return { rows, capped: result.stopped === 'results' }
}
