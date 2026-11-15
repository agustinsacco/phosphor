import { stat } from 'node:fs/promises'
import type { LocalArchiveRestore } from '@shared/lane-archive'
import { archiveIdFor, type ArchiveRecord } from '@phosphor/session-runtime/lane-archive/storage'
import {
  assertArchivedWorktree,
  parkedTranscript,
  missing,
  statIfPresent,
} from '@phosphor/session-runtime/lane-archive/files'
import { gitInfo } from '@phosphor/session-runtime/git/git-info'
import { sessionPathKey } from '@phosphor/session-runtime/pi/session-path-lock'
import { registry } from '../registry'
import { clearDraft, getPrefs, setDrafts } from '../store'
import { deleteDraftBlobs } from '../drafts-blobs'
import { createLaneRemoval } from '../pi/delete-lane'
import { sessionPaths } from '../pi/session-path-lock'
import { listSessions, parseSessionFile } from '../pi/session-scanner'
import { notifyWorkspaceSessions, unwatchWorkspaceSessions } from '../pi/session-watcher'
import { withWorkspace } from '../maintenance/history'
import { removeWorktree } from '../fs/git-worktrees'
import { deleteSession } from '../pi/session-deleter'
import { assertNoArchivedOwners, localArchives } from './state'

export async function archiveLocalLane(
  cwd: string,
  path?: string,
  sessionId?: string,
): Promise<string[]> {
  cwd = (sessionId && registry.get(sessionId)?.workspacePath) || cwd
  return withWorkspace(cwd, async () => {
    const { storage, inventory } = localArchives()
    const git = await gitInfo(cwd)
    let saved = false
    const save = async (file?: string) => {
      const id = archiveIdFor(file ?? `empty:${sessionId ?? cwd}`)
      const existing = await storage.get(id).catch((error: unknown) => {
        if (missing(error)) return null
        throw error
      })
      if (!existing) {
        const info = file ? await statIfPresent(file) : null
        const meta =
          file && info ? await parseSessionFile(file, info.mtimeMs).catch(() => null) : null
        await storage.prepare({
          id,
          cwd,
          title: meta?.name || meta?.firstUserText?.slice(0, 160) || 'Untitled lane',
          ...(info && file ? { transcript: file } : {}),
          metadata: { draftKey: `session:${file ?? path ?? sessionId}` },
          worktree: git.isWorktree === true,
          ...(git.mainRepoPath ? { repository: git.mainRepoPath } : {}),
        })
      }
      await storage.archive(id)
      saved = true
    }
    const disposed = await createLaneRemoval(save, async () => {})(path, sessionId)
    if (!saved) await save()
    inventory.invalidate()
    notifyWorkspaceSessions(cwd)
    if (
      !(await listSessions(cwd)).length &&
      !registry.list().some((lane) => lane.workspacePath === cwd)
    )
      await unwatchWorkspaceSessions(cwd)
    return disposed
  })
}

async function withArchive<T>(id: string, run: (record: ArchiveRecord) => Promise<T>): Promise<T> {
  const record = await localArchives().storage.get(id)
  return withWorkspace(record.cwd, async () => {
    const key = record.transcript ?? `archive:${id}`
    sessionPaths.cancelSessionOpens(key)
    return sessionPaths.withSessionPath(key, async () => {
      if (
        registry
          .list()
          .some((lane) => lane.diskPath && sessionPathKey(lane.diskPath) === sessionPathKey(key))
      )
        throw new Error('This conversation is open. Stop it before changing its archive.')
      return run(await localArchives().storage.get(id))
    })
  })
}

export function restoreLocalArchive(
  id: string,
  restoredSessionId?: string,
): Promise<LocalArchiveRestore> {
  return withArchive(id, async (record) => {
    const { storage, inventory } = localArchives()
    await stat(record.cwd) // No silent recreation or replacement of a missing checkout.
    const draftKey =
      typeof record.metadata?.draftKey === 'string' ? record.metadata.draftKey : undefined
    let restoredDraftKey: string | undefined
    if (restoredSessionId !== undefined) {
      const live = registry.get(restoredSessionId)
      if (
        record.transcript ||
        record.state !== 'restoring' ||
        !live ||
        sessionPathKey(live.workspacePath) !== sessionPathKey(record.cwd)
      )
        throw new Error('The replacement session is unavailable. Retry restoring this archive.')
      restoredDraftKey = `session:${live.client.sessionFile ?? restoredSessionId}`
      const drafts = { ...getPrefs().drafts }
      if (draftKey && drafts[draftKey] && draftKey !== restoredDraftKey) {
        if (drafts[restoredDraftKey]?.text.trim() || drafts[restoredDraftKey]?.attachments.length)
          throw new Error('The replacement session already has a draft. The archive was kept.')
        drafts[restoredDraftKey] = { ...drafts[draftKey], key: restoredDraftKey }
        delete drafts[draftKey]
        setDrafts(drafts) // Move references atomically; never unlink shared image blobs.
      }
    } else await storage.restore(id)
    // A never-sent lane has no discoverable transcript. Keep its intent until the
    // client has successfully created a replacement and its persisted draft is safe.
    if (record.transcript || restoredSessionId !== undefined) await storage.finish(id)
    inventory.invalidate()
    notifyWorkspaceSessions(record.cwd)
    return {
      cwd: record.cwd,
      ...(record.transcript ? { path: record.transcript } : {}),
      ...(draftKey ? { draftKey } : {}),
      ...(restoredDraftKey ? { restoredDraftKey } : {}),
    }
  })
}

export function purgeLocalArchive(id: string, removeCheckout: boolean): Promise<void> {
  return withArchive(id, async (record) => {
    const { storage, inventory } = localArchives()
    await storage.purge(id, async () => {
      if (removeCheckout) {
        if (!record.worktree || !record.repository)
          throw new Error('Project folders cannot be removed.')
        await assertNoArchivedOwners(record.cwd, id)
        await assertArchivedWorktree(record)
        if (
          (await listSessions(record.cwd)).length ||
          registry
            .list()
            .some((lane) => sessionPathKey(lane.workspacePath) === sessionPathKey(record.cwd))
        )
          throw new Error('Another lane still uses this checkout.')
        if (await statIfPresent(record.cwd)) {
          const result = await removeWorktree(record.repository, record.cwd, { force: true })
          if (!result.removed)
            throw new Error(
              'The worktree could not be removed. Retry cleanup while keeping the checkout.',
            )
        }
      }
      if (record.transcript) {
        // Keep legacy provider cleanup and artifact retention; child-run cleanup is shared.
        await deleteSession(parkedTranscript(record))
        await deleteDraftBlobs(clearDraft(`session:${record.transcript}`))
      }
    })
    await storage.finish(id)
    inventory.invalidate()
    notifyWorkspaceSessions(record.cwd)
  })
}
