import { piSessionsRoot } from '../pi/pi-paths'
import { onBeforeSessionDelete } from '../pi/session-deleter'
import { registry } from '../registry'
import { log } from '../debug-log'
import { ArtifactLibrary } from './artifact-library'
import { artifactStoreRoot } from './artifact-store-root'

export const artifactLibrary = new ArtifactLibrary(artifactStoreRoot, log)

/** Long enough that startup (windows, the last session's resume) goes first. */
const BACKFILL_DELAY_MS = 20_000

/**
 * Keep the store current with every live session, whoever started it (the
 * renderer, a routine): a turn's tool results are on disk once it ends, so
 * that is when there is something new to index, plus once more when the
 * process exits.
 * Then, once per launch, catch up with every session file on disk.
 *
 * A deleted session's artifacts stay, marked as such, until removed from the
 * Artifacts page. Its last turn is indexed before the file goes, since the
 * per-turn trigger would find the file already gone.
 */
export function startArtifactSync(): void {
  onBeforeSessionDelete(async (path) => {
    await artifactLibrary.indexFile(path)
  })
  registry.on('created', (session) => {
    let file = session.client.sessionFile
    const schedule = (): void => {
      file = session.client.sessionFile ?? file
      if (file) artifactLibrary.schedule(file)
    }
    session.client.on('event', (event) => {
      if (event.type === 'agent_end' || event.type === 'compaction_end') schedule()
    })
    session.client.on('exit', schedule)
  })
  setTimeout(() => {
    void artifactLibrary
      .backfill(piSessionsRoot())
      .then((result) => {
        if (result.indexed || result.failed) log('artifacts', 'backfill complete', result)
      })
      .catch((error: unknown) => log('artifacts', 'backfill failed', { error: String(error) }))
  }, BACKFILL_DELAY_MS).unref()
}
