import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { McpResolvedServer } from '@shared/mcp'

const state = vi.hoisted(() => ({ dir: '', marker: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.dir } }))
vi.mock('../debug-log', () => ({ log: vi.fn() }))
vi.mock('./mcp-actions', () => ({
  piCli: () =>
    Promise.resolve({
      binaryPath: process.execPath,
      prefixArgs: [join(__dirname, '__fixtures__', 'stock-pi-mcp.cjs')],
      cwd: state.dir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', MCP_TEST_MARKER: state.marker },
    }),
}))
const server = (name: string): McpResolvedServer => {
  const config = { url: `https://${name}.test/mcp` }
  return { name, scope: 'global', config, defined: config } as McpResolvedServer
}
vi.mock('./mcp-config', () => ({
  readMcpConfigs: () =>
    Promise.resolve({
      servers: ['linear', 'datadog', 'slack', 'notion'].map(server),
      files: [],
      errors: [],
      projectTrust: null,
      legacy: false,
    }),
}))

import { checkMcpServer, disposeMcpConnections } from './mcp-inspection'

beforeAll(async () => {
  state.dir = await mkdtemp(join(tmpdir(), 'mcp-stock-pi-'))
  state.marker = join(state.dir, 'events')
})
afterAll(async () => {
  await disposeMcpConnections(true)
  await rm(state.dir, { recursive: true, force: true })
})

const events = async () => (await readFile(state.marker, 'utf8')).trim().split('\n')
const checkAll = (round: number) =>
  Promise.all(
    ['linear', 'datadog', 'slack'].map((name) =>
      checkMcpServer(1, name, undefined, `r${round}-${name}`),
    ),
  )

it('answers stock pi checks from one shared pi mcp list instead of failing', async () => {
  const [linear, datadog, slack] = await checkAll(1)
  expect(linear).toMatchObject({
    ok: true,
    snapshot: {
      report: {
        name: 'linear',
        state: 'connected',
        tools: [
          { name: 'search', exposure: 'codemode' },
          { name: 'save_issue', exposure: 'direct' },
        ],
      },
    },
  })
  expect(datadog).toMatchObject({
    ok: true,
    snapshot: { report: { state: 'needs-auth', tools: [], error: 'Sign in required.' } },
  })
  expect(slack).toMatchObject({
    ok: true,
    snapshot: { report: { tools: [{ name: 'post', exposure: 'deferred' }] } },
  })
  // One capability probe decides for the rest; the list is shared, not run per card.
  expect(await events()).toEqual(['inspect', 'list'])
  await checkAll(2)
  expect(await events()).toEqual(['inspect', 'list', 'list'])
})

it('reports a connector pi did not list as a failed check', async () => {
  expect(await checkMcpServer(1, 'notion', undefined, 'missing')).toEqual({
    ok: false,
    message: 'pi did not report this connector. Test again.',
  })
})
