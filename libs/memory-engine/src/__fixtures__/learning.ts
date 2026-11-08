import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  BrainLearningCompletion,
  BrainLearningStart,
} from '@phosphor/shared/brain-learning-jobs'
import { openMemoryStore } from '../service'
import type { BrainLearningEntry } from '@phosphor/shared/brain-learning'

export function dependency(entry: BrainLearningEntry): BrainLearningEntry {
  const { entryId, parentId, entryHash, rootId } = entry
  return { entryId, parentId, entryHash, rootId }
}

export const scope = '/learning'
export const usage = { input: 101, output: 20, cacheRead: null, cacheWrite: 0, reasoning: 5 }
export const prefs = {
  enabled: true,
  recall: false,
  workspaces: [scope, '/other'],
  processor: null,
  retentionDays: 30,
}
export function start(jobId = 'owner-1'): BrainLearningStart {
  const contribution = {
    entryId: 'input',
    parentId: null,
    entryHash: 'entry-hash',
    rootId: 'content-hash',
    projectedHash: 'projected-hash',
  }
  return {
    jobId,
    scope,
    branch: null,
    target: { workspacePath: scope, sessionPath: '/sessions/source.jsonl' },
    binding: {
      provider: 'native',
      modelId: 'model',
      api: 'messages',
      accountId: 'slot',
      authMode: 'oauth',
      thinkingLevel: 'off',
      endpoint: 'https://provider.invalid',
    },
    checkpoint: {
      source: {
        sessionId: 'source',
        selectedLeafId: 'input',
        sourceDigest: 'source-digest',
        contentDigest: 'content-digest',
      },
      sourceEntryCount: 1,
      projectionDigest: 'projection-digest',
    },
    covered: [contribution],
    dependencyRootIds: ['input'],
    dependencies: [dependency(contribution)],
    evidence: [
      {
        ...contribution,
        evidenceId: 'wire-evidence',
        rootIds: ['input'],
        role: 'user',
        text: 'Alice owns Project.',
        sourceType: 'message',
        eligible: true,
      },
    ],
    expectedPolicyEpoch: 1,
  }
}
export function findings(): BrainLearningCompletion {
  return {
    usage,
    outcome: {
      type: 'findings',
      findings: [
        {
          subject: { label: 'Alice', kind: 'person' },
          predicate: 'owns',
          object: { label: 'Project', kind: 'project' },
          validFrom: null,
          validTo: null,
          summary: 'Alice owns Project.',
          kind: 'reported',
          citations: [{ evidenceId: 'wire-evidence', quote: 'Alice owns Project.' }],
        },
      ],
    },
  }
}
export function learningFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'learning-engine-'))
  const stores: ReturnType<typeof openMemoryStore>[] = []
  let now = 1000
  const open = () => {
    const store = openMemoryStore({ directory, Database: DatabaseSync, now: () => now })
    stores.push(store)
    return store
  }
  const store = open()
  store.setPrefs(prefs)
  return {
    store,
    open,
    directory,
    advance: (ms: number) => {
      now += ms
    },
    cleanup: () => {
      for (const item of stores) item.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}
