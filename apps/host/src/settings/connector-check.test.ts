import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { checkConnectors } from './connector-check'

let directory: string | undefined
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

it('keeps pi’s connector report when a server is down and pi mcp list exits 1', async () => {
  directory = await mkdtemp(join(tmpdir(), 'host-mcp-list-'))
  const pi = join(directory, 'pi.cjs')
  await writeFile(
    pi,
    `process.stdout.write(JSON.stringify({ servers: [
      { name: 'linear', state: 'connected', tools: ['search', 'save_issue'] },
      { name: 'datadog', state: 'needs-auth', tools: [] },
    ], errors: [] }))
    process.exitCode = 1`,
  )
  const state = {
    options: {
      pi: { binaryPath: process.execPath, prefixArgs: [pi] },
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      context: { home: directory },
    },
    workspace: () => undefined,
    revision: () => 'r1',
    connectorGeneration: 0,
    connectorChecks: new Map<string, { servers: Map<string, unknown> }>(),
  }
  await expect(
    checkConnectors(state as never, { section: 'connectors' }, () => true),
  ).resolves.toBeUndefined()
  expect(Object.fromEntries(state.connectorChecks.get('')!.servers)).toEqual({
    linear: { state: 'connected', tools: 2 },
    datadog: { state: 'needs-auth', tools: 0 },
  })
})
