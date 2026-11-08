import { expect, it } from 'vitest'
import type { LaneSourceFacts } from '@phosphor/shared/host-protocol-lane-transfer'
import { parseLaneRuntimeFacts } from '@phosphor/shared/lane-transfer-runtime'
import { runtimeBlockers, type TransferRuntime } from './runtime'
import { transcriptFacts } from './transcript'

const source: LaneSourceFacts = {
  sessionId: '01a1b11c-7705-7534-964e-c100db3101ce',
  title: 'Keep me',
  workspace: 'notes',
  cwd: '/notes',
  git: null,
  bytes: 100,
  transcriptBytes: 100,
  runtime: {
    piVersion: '0.86.0',
    claudeVersion: '0.10.0',
    provider: 'pi-claude-cli',
    model: 'claude-test',
  },
}
const target: TransferRuntime = {
  piVersion: '0.86.0',
  claudeVersion: '0.10.0',
  models: [{ provider: 'pi-claude-cli', id: 'claude-test' }],
}

it('refuses an older or unknown pi and unavailable provider/model, but accepts newer pi', () => {
  expect(runtimeBlockers(source, target)).toEqual([])
  expect(runtimeBlockers(source, { ...target, piVersion: '0.87.0' })).toEqual([])
  expect(runtimeBlockers(source, { ...target, piVersion: '0.85.0' })).toContain(
    'Update pi on the target: it is older than the source’s pi.',
  )
  expect(runtimeBlockers(source, { ...target, piVersion: null })).toContain(
    'Pi’s version could not be checked on both machines.',
  )
  expect(runtimeBlockers({ ...source, runtime: undefined }, target)).toContain(
    'Pi’s version could not be checked on both machines.',
  )
  expect(runtimeBlockers(source, { ...target, models: [] })).toContain(
    'This lane’s provider and model are unavailable on the target.',
  )
  expect(runtimeBlockers(source, { ...target, claudeVersion: '0.9.9' })).toContain(
    'Update pi-claude-cli on the target to 0.10.0 or newer.',
  )
})

it('takes the last model choice without changing the conversation', () => {
  const facts = transcriptFacts(
    [
      { type: 'model_change', provider: 'anthropic', modelId: 'old' },
      { type: 'model_change', provider: 'pi-claude-cli', modelId: 'claude-test' },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n'),
  )
  expect(facts).toMatchObject({ provider: 'pi-claude-cli', model: 'claude-test' })
})

it('strictly parses the runtime wire facts without accepting extra fields', () => {
  expect(parseLaneRuntimeFacts(source.runtime)).toEqual(source.runtime)
  expect(parseLaneRuntimeFacts({ ...source.runtime, secret: 'no' })).toBeNull()
  expect(parseLaneRuntimeFacts({ ...source.runtime, piVersion: '../bad' })).toBeNull()
})
