/**
 * A second Host process's startup recovery on a shared `<state>`, for the interleaving tests.
 * Its importer stops until told to go on, so a test can hold it inside a roll-forward.
 * argv: <stateDirectory>
 * Commands: `recover` answers `{importing}` when its importer starts (if it does) and then
 * `{events}` when recovery ends; `continue` lets a waiting importer finish (no answer).
 */
import { recoverBrainHandover } from '../recover'

const [stateDir] = process.argv.slice(-1)
const report = (value: object): void => {
  process.stdout.write(JSON.stringify(value) + '\n')
}

let proceed: (() => void) | undefined
const released = new Promise<void>((resolve) => (proceed = resolve))

async function recover(): Promise<void> {
  const events: [string, Record<string, unknown> | undefined][] = []
  await recoverBrainHandover({
    stateDir: stateDir!,
    importAgentTranscripts: async (input) => {
      report({ importing: input.migrationId })
      await released
      return { bound: input.transcripts[0]?.sessionId ?? null }
    },
    log: (event, fields) => events.push([event, fields]),
  })
  report({ events })
}

let buffered = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  buffered += chunk
  for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
    const command = buffered.slice(0, end).trim()
    buffered = buffered.slice(end + 1)
    if (command === 'continue') proceed?.()
    else if (command === 'recover')
      recover().catch((error: unknown) => report({ error: String(error) }))
    else report({ error: `unknown command ${command}` })
  }
})
