import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { EMBEDDING_MODEL } from '@phosphor/brain-runtime/embedding/model-manifest'
import { isUuid } from '@phosphor/shared/control-api'
import { isBrainHandoverName, parseOwnerParams } from '@phosphor/shared/host-protocol-owner'
import { statIfPresent } from '@phosphor/session-runtime/host-install/brain-compatibility'
import {
  LOCAL_BRAIN_OWNER_FILE,
  readLocalBrainSelection,
} from '@phosphor/session-runtime/brain/local-owner'
import { isOwnerPrivate } from '@phosphor/session-runtime/fs-safety'
import { readHandover, readPublished } from '../brain-handover/layout'

const STORE = 'brain.sqlite'
const STORE_FILES = [STORE, `${STORE}-wal`, `${STORE}-shm`, `${STORE}-journal`]
const MODEL = `embeddings/embedding-models/${EMBEDDING_MODEL.directoryName}`
const modelPaths = EMBEDDING_MODEL.files.map(({ path }) => `${MODEL}/${path}`)
const brainFiles = [
  ...STORE_FILES,
  'handover.json',
  'agent-lane.json',
  'Brain/AGENTS.md',
  ...modelPaths,
  ...modelPaths.map((path) =>
    path.replace(
      `${MODEL}/`,
      `embeddings/embedding-models/.staging-${EMBEDDING_MODEL.directoryName}/`,
    ),
  ),
]

function unsafe(): never {
  throw new Error('Brain state is unsafe or unknown; nothing will be purged.')
}

function safeNode(path: string, uid: number | undefined, directory: boolean): void {
  const info = lstatSync(path)
  // Some files (e.g. downloaded model bytes) rely on the private enclosing Brain folder.
  if (
    info.uid !== uid ||
    (info.mode & 0o022) !== 0 ||
    (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
  )
    unsafe()
}

function privateRoot(path: string, uid: number | undefined): void {
  const info = lstatSync(path)
  if (!info.isDirectory() || !isOwnerPrivate(info, uid)) unsafe()
}

/** Walk only known paths, never links. A known model directory may contain a partial download. */
function checkFiles(
  root: string,
  uid: number | undefined,
  files: readonly string[],
  dirs: readonly string[] = [],
  transcriptDir = false,
  prefix = '',
): void {
  for (const name of readdirSync(join(root, prefix))) {
    const path = prefix ? `${prefix}/${name}` : name
    if (dirs.includes(path) || files.some((file) => file.startsWith(`${path}/`))) {
      safeNode(join(root, path), uid, true)
      checkFiles(root, uid, files, dirs, transcriptDir, path)
    } else if (
      files.includes(path) ||
      (transcriptDir && path.startsWith('transcripts/') && isBrainHandoverName(path))
    ) {
      safeNode(join(root, path), uid, false)
    } else unsafe()
  }
}

function checkMoveFolders(move: string, uid: number | undefined, committed: boolean): void {
  for (const entry of readdirSync(move)) {
    if (entry === 'state.json') safeNode(join(move, entry), uid, false)
    else if (committed && entry === 'stage') {
      const stage = join(move, entry)
      privateRoot(stage, uid)
      checkFiles(stage, uid, [STORE, 'AGENTS.md', ...modelPaths], ['transcripts'], true)
    } else if (committed && entry === 'sealed') {
      const sealed = join(move, entry)
      privateRoot(sealed, uid)
      // Publication has already renamed sealed/brain out; only transcripts can remain.
      checkFiles(sealed, uid, [], ['transcripts'], true)
    } else unsafe()
  }
}

/** Check ownership and terminal move state before uninstall is allowed to mutate anything. */
export function checkBrainPurge(state: string, uid: number | undefined, entries: string[]): void {
  if (entries.includes(LOCAL_BRAIN_OWNER_FILE)) {
    safeNode(join(state, LOCAL_BRAIN_OWNER_FILE), uid, false)
    const owner = readLocalBrainSelection(state, uid)
    if (owner !== 'host' && owner !== 'desktop') unsafe()
  }
  const brain = join(state, 'brain')
  const moves = join(state, 'brain-handover')
  let published: ReturnType<typeof readPublished> = null
  if (entries.includes('brain')) {
    privateRoot(brain, uid)
    checkFiles(brain, uid, brainFiles, ['Brain'])
    safeNode(join(brain, STORE), uid, false)
    published = readPublished(state)
    if (published && !isUuid(published.migrationId)) unsafe()
  }
  let matched = false
  if (entries.includes('brain-handover')) {
    privateRoot(moves, uid)
    if (statIfPresent(join(moves, 'active.json')))
      throw new Error('Brain move is still claimed; complete or abort it before purging.')
    for (const id of readdirSync(moves)) {
      if (!isUuid(id)) unsafe()
      const move = join(moves, id)
      privateRoot(move, uid)
      safeNode(join(move, 'state.json'), uid, false)
      const record = readHandover(state, id)
      if (!parseOwnerParams('owner.brainHandover.begin', record)) unsafe()
      if (record?.state === 'committed') {
        if (published?.migrationId !== id || published.sourceGeneration !== record.sourceGeneration)
          unsafe()
        matched = true
      } else if (record?.state !== 'aborted') {
        throw new Error('Brain move is unfinished; complete or abort it before purging.')
      }
      checkMoveFolders(move, uid, record.state === 'committed')
    }
  }
  if (published && !matched) unsafe()
}
