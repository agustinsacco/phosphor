import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { McpInspectionCache, inspectionKey } from './mcp-inspection-cache'
import type { McpInspection } from '@phosphor/shared/mcp-inspection'
import type { McpResolvedServer } from '@phosphor/shared/mcp'

let directory: string
const report: McpInspection = {
  name: 'test',
  state: 'connected',
  tools: [{ name: 'search', description: 'Search incidents', exposure: 'codemode' }],
}
const server: McpResolvedServer = {
  name: 'test',
  scope: 'global',
  config: { url: 'https://example.test', headers: { Authorization: 'secret-value' } },
  defined: {},
}
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})
async function cachePath() {
  directory = await mkdtemp(join(tmpdir(), 'mcp-cache-'))
  return join(directory, 'metadata.json')
}
it('remembers descriptions across restarts and failures, never stores config credentials', async () => {
  const path = await cachePath()
  const key = inspectionKey('/workspace', server)
  const cache = new McpInspectionCache(path)
  const success = await cache.put(key, report)
  const failed = await cache.put(key, {
    name: 'test',
    state: 'failed',
    tools: [],
    error: 'Unavailable',
  })
  expect(failed.tools).toEqual(report.tools)
  expect(failed.discoveredAt).toBe(success.discoveredAt)
  expect(await new McpInspectionCache(path).get(key)).toEqual(failed)
  expect(await readFile(path, 'utf8')).not.toContain('secret-value')
  if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
})
it('isolates workspaces and invalidates changed connector configuration', async () => {
  const cache = new McpInspectionCache(await cachePath())
  const key = inspectionKey('/workspace', server)
  await cache.put(key, report)
  expect(await cache.get(inspectionKey('/different', server))).toBeUndefined()
  expect(
    await cache.get(
      inspectionKey('/workspace', { ...server, config: { url: 'https://changed.test' } }),
    ),
  ).toBeUndefined()
})
it('ignores corrupt caches and bounds the number of retained entries', async () => {
  const path = await cachePath()
  await writeFile(path, 'invalid')
  const cache = new McpInspectionCache(path)
  expect(await cache.get('missing')).toBeUndefined()
  for (let index = 0; index < 66; index++)
    await cache.put(inspectionKey(String(index), server), report)
  expect(await cache.get(inspectionKey('0', server))).toBeUndefined()
  expect(JSON.parse(await readFile(path, 'utf8'))).toHaveLength(64)
})
