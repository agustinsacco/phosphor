import type { BrainServiceOptions, BrainUI } from './service-types'
import type { DesktopMemoryClient } from './memory-client'
import type { BrainStatus } from '@phosphor/shared/brain'
import type { createBrainIndexer } from './indexer'
import type { createBrainProcessor } from './processor'
import type { createBrainTranscripts } from './transcripts'
import { bounded, canonicalPrefs, identifier, laneAuthority } from './authority'

interface Controller {
  options: BrainServiceOptions
  store: DesktopMemoryClient
  indexer: ReturnType<typeof createBrainIndexer>
  processor: ReturnType<typeof createBrainProcessor>
  transcripts: ReturnType<typeof createBrainTranscripts>
  serialize<T>(operation: () => Promise<T>): Promise<T>
  status(): Promise<BrainStatus>
  revoke(): Promise<void>
  isClosed(): boolean
}
export function createBrainUI(controller: Controller): BrainUI {
  const { options, store, indexer, processor, transcripts, serialize, status, revoke, isClosed } =
    controller
  const ui: BrainUI = {
    'brain:status': status,
    'brain:setPrefs': (prefs) =>
      serialize(async () => {
        bounded(prefs)
        const canonical = await canonicalPrefs(prefs)
        await revoke()
        const snapshot = await store.setPrefs(canonical)
        await options.embeddings.setEnabled(snapshot.prefs.enabled)
        return status()
      }),
    'brain:download': async (acceptTerms) => {
      if (isClosed() || acceptTerms !== true)
        throw new Error('Explicit model terms acknowledgement required')
      await options.embeddings.download(true)
      await indexer.index()
      return status()
    },
    'brain:removeModel': async () => {
      if (isClosed()) throw new Error('Brain is disposed')
      await options.embeddings.remove()
      return status()
    },
    'brain:search': async (query) => {
      bounded(query)
      const snapshot = await store.snapshot()
      const scopes = query.scopes ?? snapshot.prefs.workspaces
      if (
        !Array.isArray(scopes) ||
        scopes.some((scope) => !snapshot.prefs.workspaces.includes(scope))
      )
        throw new Error('Brain search scope unavailable')
      return indexer.search(query, scopes)
    },
    'brain:read': async (id) =>
      store.read(identifier(id), (await store.snapshot()).prefs.workspaces),
    'brain:graph': (id) => store.graph(id === undefined ? undefined : identifier(id)),
    'brain:process': (scope, consent) =>
      serialize(async () => {
        bounded(consent)
        const canonical = (await laneAuthority(scope)).scope
        return processor.process(canonical, consent)
      }),
    'brain:cancel': (id) => serialize(() => processor.cancel(identifier(id))),
    'brain:review': (id, approve, revision) =>
      serialize(async () => {
        if (typeof approve !== 'boolean') throw new Error('Invalid Brain review')
        await store.review(identifier(id), approve, bounded(revision))
      }).then(() => indexer.index()),
    'brain:correct': (id, correction, revision) =>
      serialize(async () => {
        await store.correct(identifier(id), bounded(correction), bounded(revision))
      }).then(() => indexer.index()),
    'brain:forget': (ids) =>
      serialize(async () => {
        if (!Array.isArray(ids) || ids.length > 500)
          throw new Error('Invalid Brain forget selection')
        await revoke()
        const result = await store.forget(ids.map(identifier))
        await transcripts.purge()
        return result
      }),
    'brain:transcript': (id) => transcripts.read(identifier(id)),
  }
  return ui
}
