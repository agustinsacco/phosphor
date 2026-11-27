/**
 * A real Host Brain process for the writer-lock tests: one `createHostBrain` on `<state>`, driven
 * by one command per stdin line, answering one JSON line each. No provider, no worker processes.
 * argv: <stateDirectory> <configLabel>
 * Commands: `enable`, `status`, `dispose`.
 */
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { inProcessSearch } from '@phosphor/brain-runtime/search/in-process'
import { openBrainSearch } from '@phosphor/memory-engine/search'
import { createHostBrain } from '../runtime'

const [stateDirectory, config] = process.argv.slice(-2)
const report = (value: object): void => {
  process.stdout.write(JSON.stringify({ config, ...value }) + '\n')
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const brain = createHostBrain({
  stateDirectory: stateDirectory!,
  resourceRoot: '/res',
  lanes: {
    busy: () => false,
    launch: async () => ({ binaryPath: '/not-a-provider', prefixArgs: [], env: {} }),
  },
  embeddings: () => ({
    status: () => ({
      phase: 'ready',
      receivedBytes: 0,
      totalBytes: 0,
      modelId: 'fake',
      dimensions: 768,
    }),
    setEnabled: async () => {},
    download: async () => {},
    remove: async () => {},
    embed: async (texts) => texts.map(() => [1, ...Array<number>(767).fill(0)]),
    dispose() {},
  }),
  openSearch: inProcessSearch((path) => openBrainSearch({ path, Database: DatabaseSync })),
  runModelCall: async () => {
    throw new Error('No provider in this test.')
  },
  log: () => {},
})

async function run(command: string): Promise<void> {
  if (command === 'enable') {
    try {
      const service = await brain.enable()
      const { prefs } = await service.api.status()
      return report({ enabled: prefs.enabled, state: brain.state() })
    } catch (error) {
      return report({ refused: message(error), state: brain.state() })
    }
  }
  if (command === 'status') {
    const service = await brain.service().catch(() => undefined)
    return report({
      state: brain.state(),
      service: service !== undefined,
      exists: existsSync(brain.directory),
    })
  }
  if (command === 'dispose') {
    await brain.dispose()
    return report({ disposed: true })
  }
  report({ error: `unknown command ${command}` })
}

let queue = Promise.resolve()
let buffered = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  buffered += chunk
  for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
    const command = buffered.slice(0, end).trim()
    buffered = buffered.slice(end + 1)
    queue = queue
      .then(() => run(command))
      .catch((error: unknown) => report({ error: message(error) }))
  }
})
