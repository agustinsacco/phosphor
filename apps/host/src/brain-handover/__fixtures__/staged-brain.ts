/**
 * A synthetic Desktop Brain staged the way Desktop stages one: a v7 file from the engine's own
 * fixture, Brain Agent's rules and one transcript, with their sizes and hashes. Invented names.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrainHandoverFile } from '@phosphor/shared/host-protocol-owner'
import { createBrainHandoverHandlers, type BrainHandoverPorts } from '../handlers'
import type { PinnedEmbeddingModel } from '../seal'

const V7 = new URL(
  '../../../../../libs/memory-engine/src/__fixtures__/schema-v7.sql',
  import.meta.url,
)

export const RULES = '# Brain Agent\n\nAsk Mara Voss before merging Harbor records.\n'
export const TRANSCRIPT =
  JSON.stringify({ type: 'session', version: 3, id: 'brain-agent-1', cwd: '/made-up/Brain' }) +
  '\n' +
  JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user', content: 'Defrag' } }) +
  '\n'

export function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function v7Database(path: string): void {
  const db = new DatabaseSync(path)
  db.exec(readFileSync(V7, 'utf8'))
  db.close()
}

export function describeFile(stage: string, name: string): BrainHandoverFile {
  const bytes = readFileSync(join(stage, name))
  return { name, bytes: statSync(join(stage, name)).size, sha256: sha256(bytes) }
}

/** A stand-in for the pinned embedding model: one small file the Host pins by hash. */
export const MODEL_CONFIG = '{"model":"harbor-synthetic"}\n'
export const PINNED_MODEL: PinnedEmbeddingModel = {
  directoryName: 'harbor-model',
  files: [
    { path: 'config.json', bytes: Buffer.byteLength(MODEL_CONFIG), sha256: sha256(MODEL_CONFIG) },
  ],
}
export const MODEL_FILE = 'embeddings/embedding-models/harbor-model/config.json'
/** The transcript Desktop would resume next, named in `verify`. */
export const ACTIVE = 'transcripts/brain-agent-1.jsonl'

/** Writes the database, rules, transcript and model into `stage`; returns their descriptions. */
export function stageBrain(stage: string): BrainHandoverFile[] {
  v7Database(join(stage, 'brain.sqlite'))
  writeFileSync(join(stage, 'AGENTS.md'), RULES, { mode: 0o600 })
  mkdirSync(join(stage, 'transcripts'), { mode: 0o700 })
  writeFileSync(join(stage, ACTIVE), TRANSCRIPT, { mode: 0o600 })
  mkdirSync(join(stage, MODEL_FILE, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(join(stage, MODEL_FILE), MODEL_CONFIG, { mode: 0o600 })
  return ['brain.sqlite', 'AGENTS.md', ACTIVE, MODEL_FILE].map((name) => describeFile(stage, name))
}

export interface Imported {
  calls: Parameters<NonNullable<BrainHandoverPorts['importAgentTranscripts']>>[0][]
  /** Each call's sealed transcript bytes, read when the importer ran: a commit then drops them. */
  read: string[][]
  fail: boolean
  /** Folders the model probe ran on, and whether it reports the model usable. */
  probed: string[]
  usable: boolean
}

export function handoverWorld() {
  const stateDir = mkdtempSync(join(tmpdir(), 'harbor-host-'))
  const imported: Imported = { calls: [], read: [], fail: false, probed: [], usable: true }
  const ports = (over: Partial<BrainHandoverPorts> = {}): BrainHandoverPorts => ({
    stateDir,
    uid: process.getuid?.(),
    now: () => Date.parse('2026-11-01'),
    laneForSessionFile: (path) => path === '/made-up/northwind-lane.jsonl',
    readerReadiness: () => Promise.resolve('qualified'),
    embeddingModel: PINNED_MODEL,
    probeModel: async (directory) => {
      imported.probed.push(directory)
      return imported.usable
    },
    importAgentTranscripts: async (input) => {
      imported.calls.push(input)
      imported.read.push(input.transcripts.map((t) => readFileSync(t.path, 'utf8')))
      if (imported.fail) throw new Error('binding failed')
      return { bound: input.transcripts[0]?.sessionId ?? null }
    },
    ...over,
  })
  return {
    stateDir,
    imported,
    ports,
    /** A fresh set of handlers over the same state: a Host restart. */
    restart: (over: Partial<BrainHandoverPorts> = {}) => createBrainHandoverHandlers(ports(over)),
    migrationId: () => randomUUID(),
    dispose: () => rmSync(stateDir, { recursive: true, force: true }),
  }
}

export const BEGIN = { sourceSchema: 7 as const, sourceGeneration: 'id-1', desktopVersion: '1.2.3' }
