import { WorkspaceLeased, type WorkspaceLeases } from '../owner/lease'
import { sessionPathKey } from '@phosphor/session-runtime/pi/session-path-lock'
import { realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createLaneArchiveStorage,
  type ArchiveRecord,
} from '@phosphor/session-runtime/lane-archive/storage'
import { createArchiveInventory } from '@phosphor/session-runtime/lane-archive/inventory'
import { assertArchivedWorktree, statIfPresent } from '@phosphor/session-runtime/lane-archive/files'
import { git } from '@phosphor/session-runtime/git/git-exec'
import type { LaneArchiveOp } from '@phosphor/shared/lane-archive'
import type { RejectCode } from '@phosphor/shared/host-protocol'
import type { HostFeature } from '../features/feature'
import type { HostAttachments } from '../features/attachments'
import type { HostRuntime } from '../session/runtime'
import type { HostTerminals } from '../terminals/service'
import type { HostStore } from './store'
import type { LaneSessions } from './create'
import { isInsideResolved } from '@phosphor/session-runtime/fs-safety'
import {
  archiveAttachmentsPath,
  attachmentIdentity,
  moveArchiveAttachments,
  purgeArchiveAttachments,
} from './archive-attachments'

type Options = {
  leases?: WorkspaceLeases
  directory: string
  sessionsRoot: string
  store: HostStore
  runtime: Pick<HostRuntime, 'mutateStoppedSession'>
  stop(id: string, allowed: () => boolean): Promise<void>
  /** Starts the fresh session a restored never-sent lane resumes into. */
  sessions: LaneSessions
  forget(id: string): void
  announce(id: string): void
  changed?(id: string): void
  terminals?: Pick<HostTerminals, 'reap'>
  attachments?: Pick<HostAttachments, 'abort'>
}
type Outcome = { ok: true; data?: unknown } | { ok: false; code: RejectCode }
const requireAllowed = (allowed: () => boolean) => {
  if (!allowed()) throw new Error('forbidden')
}

export class HostArchives {
  private readonly storage
  private readonly inventory
  readonly feature: HostFeature
  constructor(private readonly options: Options) {
    this.storage = createLaneArchiveStorage(
      join(options.directory, 'lane-archive'),
      options.sessionsRoot,
    )
    this.inventory = createArchiveInventory(this.storage, (record) => [
      archiveAttachmentsPath(options.directory, record.id),
    ])
    this.feature = {
      capability: 'sessions.read',
      methods: ['archive.list'],
      call: async (_method, params, allowed) => {
        if (allowed && !allowed())
          return { ok: false, error: { code: 'forbidden', message: 'Access changed.' } }
        if (
          params !== undefined &&
          (typeof params !== 'object' ||
            params === null ||
            Object.keys(params).some((key) => key !== 'measure') ||
            ('measure' in params && typeof params.measure !== 'boolean'))
        )
          return { ok: false, error: { code: 'bad-request', message: 'Invalid archive query.' } }
        const measure = Boolean(params && 'measure' in params && params.measure)
        return { ok: true, data: await this.inventory.list(measure) }
      },
    }
  }
  async ownsCwd(cwd: string): Promise<boolean> {
    const { entries, truncated } = await this.storage.list()
    return truncated || entries.some((record) => sessionPathKey(record.cwd) === sessionPathKey(cwd))
  }
  async execute(op: LaneArchiveOp, allowed: () => boolean): Promise<Outcome> {
    try {
      requireAllowed(allowed)
      if (op.type === 'lane.archive') await this.archive(op.laneId, allowed)
      else {
        const record = await this.storage.get(op.archiveId)
        await this.options.runtime.mutateStoppedSession(
          record.transcript ?? `archive:${record.id}`,
          async () => {
            requireAllowed(allowed)
            if (op.type === 'archive.restore') {
              const restore = () => this.restore(record, allowed)
              if (this.options.leases)
                await this.options.leases.withUse(record.cwd, 'archive', restore)
              else await restore()
            } else await this.purge(record, op.removeWorktree, allowed)
          },
        )
      }
      this.inventory.invalidate()
      this.options.changed?.(op.type === 'lane.archive' ? op.laneId : op.archiveId)
      return { ok: true }
    } catch (error) {
      if (error instanceof WorkspaceLeased) return { ok: false, code: 'busy' }
      this.inventory.invalidate()
      return { ok: false, code: allowed() ? 'bad-request' : 'forbidden' }
    }
  }
  private async archive(id: string, allowed: () => boolean) {
    const { store, stop, runtime, directory } = this.options
    const lane = store.getLane(id)
    if (!lane || lane.removedAt !== null) throw new Error('unknown lane')
    await stop(id, allowed)
    const source = store.getLane(id)?.sessionFile ?? undefined
    await runtime.mutateStoppedSession(source ?? `archive:${id}`, async () => {
      requireAllowed(allowed)
      const file = source && (await statIfPresent(source)) ? source : undefined
      const repository = store.listRepositories().find((repo) => repo.id === lane.repositoryId)
      const attachments = await attachmentIdentity(directory, id)
      const record = await this.storage.prepare({
        id,
        cwd: lane.cwd,
        title: lane.title ?? 'Untitled lane',
        worktree: lane.worktree,
        ...(file ? { transcript: file } : {}),
        ...(repository ? { repository: repository.path } : {}),
        metadata: {
          repositoryId: lane.repositoryId,
          branch: lane.branch,
          model: lane.model,
          ...(attachments ? { attachments } : {}),
        },
      })
      requireAllowed(allowed)
      store.archives.mark(id)
      this.options.attachments?.abort(id)
      try {
        await moveArchiveAttachments(directory, record)
        requireAllowed(allowed)
        await this.storage.archive(id)
      } finally {
        this.options.forget(id)
        this.options.terminals?.reap()
      }
    })
  }
  private async restore(record: ArchiveRecord, allowed: () => boolean) {
    const { store, directory } = this.options
    const repositoryId = record.metadata?.repositoryId
    if (
      typeof repositoryId !== 'string' ||
      !store.listRepositories().some((repo) => repo.id === repositoryId)
    )
      throw new Error('Add the original repository to this Host before restoring.')
    const current = store.getLane(record.id)
    const listed = current !== undefined && current !== null && current.removedAt === null
    if (!listed && store.listLanes().length >= store.limits.lanesPerHost)
      throw new Error('Host lane capacity reached.')
    await stat(record.cwd)
    requireAllowed(allowed)
    await this.storage.restore(record.id)
    await moveArchiveAttachments(directory, record, true)
    requireAllowed(allowed)
    // An old Host may have pruned the tombstone after rollback. The manifest keeps identity.
    if (!store.getLane(record.id)) {
      const restored = store.ensureLane(
        {
          repositoryId,
          cwd: record.cwd,
          sessionFile: record.transcript ?? null,
          title: record.title.slice(0, 80),
          worktree: record.worktree,
        },
        { restoreId: record.id },
      )
      if (restored.laneId !== record.id) throw new Error('Another lane owns this transcript.')
    }
    store.archives.restore(record.id)
    // A failed start leaves the archive listed, so restore can be retried.
    if (!record.transcript) await this.startFresh(record)
    await this.storage.finish(record.id)
    this.options.announce(record.id)
  }
  /**
   * pi can report a filename before its first write, and resume refuses a lane
   * without one. A never-sent lane comes back in a fresh session, as on Desktop.
   */
  private async startFresh(record: ArchiveRecord) {
    const { store, sessions } = this.options
    store.bindSessionFile(record.id, null)
    const lane = store.getLane(record.id)
    const session = await sessions.start({
      repository: record.cwd,
      ...(lane?.model ? { provider: lane.model.provider, model: lane.model.id } : {}),
    })
    try {
      await sessions.attach(record.id, session.sessionId)
    } catch (error) {
      await sessions.stop(session.sessionId)
      throw error
    }
    if (session.sessionFile) store.bindSessionFile(record.id, session.sessionFile)
  }
  private async purge(record: ArchiveRecord, removeCheckout: boolean, allowed: () => boolean) {
    const { store, directory } = this.options
    await this.storage.purge(record.id, async () => {
      requireAllowed(allowed)
      if (removeCheckout) await this.removeCheckout(record, allowed)
      requireAllowed(allowed)
      await purgeArchiveAttachments(directory, record)
    })
    requireAllowed(allowed)
    store.markRemoved(record.id)
    store.archives.forget(record.id)
    await this.storage.finish(record.id)
    this.options.forget(record.id)
  }
  private async removeCheckout(record: ArchiveRecord, allowed: () => boolean) {
    if (!record.worktree || !record.repository)
      throw new Error('Project folders cannot be removed.')
    const { store } = this.options
    const archives = await this.storage.list()
    if (
      archives.truncated ||
      archives.entries.some((entry) => entry.id !== record.id && entry.cwd === record.cwd) ||
      store.listLanes().some((lane) => lane.cwd === record.cwd)
    )
      throw new Error('Another lane uses this checkout.')
    await assertArchivedWorktree(record)
    if (!(await statIfPresent(record.cwd))) return
    const root = await realpath(record.repository)
    const cwd = await realpath(record.cwd)
    if (
      !store.listRepositories().some((repo) => repo.path === record.repository) ||
      !isInsideResolved(join(root, '.phosphor', 'worktrees'), cwd)
    )
      throw new Error('Checkout ownership changed.')
    requireAllowed(allowed)
    await git(root, ['worktree', 'remove', '--force', '--', cwd], { isolateEnv: true })
  }
}
