import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createTranscriptCache } from './cache'
import { readTranscript } from './read'

const fixtures = fileURLToPath(
  new URL(
    '../../../../../libs/session-runtime/src/pi/__fixtures__/session-context/',
    import.meta.url,
  ),
)
for (const name of readdirSync(fixtures).filter((name) => name.endsWith('.jsonl'))) {
  it(`previews pi's golden context for ${name}`, () => {
    const result = readTranscript({
      sessionFile: fixtures + name,
      sessionsRoot: fixtures,
      laneId: 'fixture',
      cache: createTranscriptCache(),
      onFailure: () => {},
    })
    const messages: unknown = JSON.parse(
      readFileSync(fixtures + name.replace('.jsonl', '.messages.json'), 'utf8'),
    )
    expect(JSON.parse(JSON.stringify(result))).toEqual({ kind: 'messages', messages })
  })
}
