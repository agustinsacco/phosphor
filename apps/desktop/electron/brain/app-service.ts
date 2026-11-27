import { createBrainBridge, type BridgeInvoke } from '@phosphor/brain-runtime/bridge'
import type { BrainService } from '@phosphor/brain-runtime/types'
import { validateBrainRequest } from '@phosphor/brain-client/validate'
import { HOST_LIMITS } from '@phosphor/shared/host-protocol'
import { OWNER_LIMITS, type OwnerIndex } from '@phosphor/shared/host-protocol-owner'
import { BrainOwnerMoved, launchedDesktopOwnsBrain } from './owner-gate'

type Bridge = Pick<Awaited<ReturnType<typeof createBrainBridge>>, 'registration' | 'close'>
type Source = () => Promise<Pick<BrainService, 'agent' | 'recallLaunch'>>
interface OwnerConnection {
  snapshot(): {
    state: string
    ownerLocal?: boolean
    connectionToken?: string
    cursor?: { epoch: string; seq: number }
    lanes: readonly { laneId: string; activity: string }[]
  }
  call(method: string, params?: unknown): Promise<{ ok: boolean; data?: unknown }>
}
interface Owner {
  link: OwnerConnection
  token: string
  receivedLanes?: boolean
  registered?: boolean
  dirty: boolean
  syncing: boolean
}

/** Session files are private owner-index data, not identities in the public lanes topic. */
async function busyFiles(link: OwnerConnection, ids: Set<string>, current: () => boolean) {
  const files = new Set<string>()
  let after: string | undefined
  const pages = Math.ceil(HOST_LIMITS.lanesPerHost / OWNER_LIMITS.indexLanesPerPage)
  for (let i = 0; i < pages && current(); i++) {
    const result = await link.call('owner.index', after === undefined ? {} : { after })
    const page = result.data as Partial<OwnerIndex> | undefined
    if (
      !result.ok ||
      !Array.isArray(page?.lanes) ||
      page.lanes.length > OWNER_LIMITS.indexLanesPerPage
    )
      break
    for (const { laneId, sessionFile } of page.lanes) {
      if (typeof sessionFile === 'string' && ids.delete(laneId)) files.add(sessionFile)
    }
    if (!ids.size) return files
    if (!page.next || (after && page.next <= after)) break
    after = page.next
  }
  return undefined
}

/** Only the local, attested slot supplies a link. Reconnect replaces the registration even on the same connection object. */
export class BrainAppService {
  private source?: Source
  private report: () => void = () => {}
  private owner?: Owner
  private bridge?: Promise<Bridge>
  private retry?: ReturnType<typeof setTimeout>
  private topic?: { key: string; ids: Set<string>; files?: Set<string>; reading?: boolean }
  private closed = false

  constructor(
    private readonly open: (invoke: BridgeInvoke) => Promise<Bridge> = createBrainBridge,
    private readonly ownsBrain: () => boolean = () => true,
  ) {}

  install(source: Source, report: () => void) {
    this.source = source
    this.report = report
    this.brainChanged()
  }

  /** The host client retains its cursor during reconnect. Only a fresh lanes frame makes the projection usable. */
  lanesSnapshot() {
    if (this.owner) this.owner.receivedLanes = true
    this.topic = undefined
  }

  ownerChanged(link?: OwnerConnection) {
    if (this.closed) return
    const view = link?.snapshot()
    if (!link || view?.state !== 'ready' || !view.ownerLocal || !view.connectionToken) {
      this.owner = this.topic = undefined
      clearTimeout(this.retry)
      return
    }
    const fresh = this.owner?.link !== link || this.owner.token !== view.connectionToken
    if (fresh) {
      clearTimeout(this.retry)
      this.topic = undefined
      this.owner = { link, token: view.connectionToken, dirty: false, syncing: false }
    }
    if (this.owner?.receivedLanes && view.cursor) {
      const ids = view.lanes
        .filter((l) => l.activity === 'working' || l.activity === 'needs-input')
        .map((l) => l.laneId)
      // Unrelated topic traffic must not starve a waiting extraction by discarding its index join.
      const key = JSON.stringify(ids.sort())
      if (this.topic?.key !== key) this.topic = { key, ids: new Set(ids) }
    }
    if (fresh) this.brainChanged()
  }

  /** Extraction polls this while waiting. Pending, incomplete and disconnected projections all wait. */
  busy(path: string): boolean {
    const owner = this.owner,
      topic = this.topic
    if (!owner || !topic) return true
    if (!topic.ids.size) return false
    if (topic.files) return topic.files.has(path)
    if (!topic.reading) {
      topic.reading = true
      void busyFiles(owner.link, new Set(topic.ids), () => this.topic === topic).then(
        (files) => {
          topic.files = files
          topic.reading = false
        },
        () => {
          topic.reading = false
          this.report()
        },
      )
    }
    return true
  }

  brainChanged() {
    const owner = this.owner
    if (!owner || !this.source || !this.ownsBrain()) return
    owner.dirty = true
    if (!owner.syncing) void this.sync(owner, this.source)
  }

  private async sync(owner: Owner, source: Source) {
    owner.syncing = true
    try {
      while (this.owner === owner && this.ownsBrain() && owner.dirty) {
        owner.dirty = false
        const service = await source()
        const recall = !!(await service.recallLaunch())
        if (this.owner !== owner || recall === owner.registered) continue
        // Host lanes hold only the lane token; this bridge's curator token is never handed out.
        this.bridge ??= this.open(async (method, input, signal, role) => {
          if (role !== 'lane' || !this.ownsBrain()) throw new Error('Brain request unavailable')
          return service.agent(method, validateBrainRequest(method, input), signal)
        }).catch((err: unknown) => {
          this.bridge = undefined
          throw err
        })
        const bridge = await this.bridge
        if (this.owner !== owner || !this.ownsBrain()) break
        const result = await owner.link.call('app.service.register', bridge.registration(recall))
        if (!result.ok) throw new Error('Registration refused')
        owner.registered = recall
      }
    } catch (error) {
      // Brain moved to the service: Desktop has nothing to register, now or later.
      if (error instanceof BrainOwnerMoved) return
      if (this.owner === owner) {
        // Never log the request, endpoint, token or a transport error containing them.
        this.report()
        clearTimeout(this.retry)
        this.retry = setTimeout(() => this.brainChanged(), 5000)
        this.retry.unref()
      }
    } finally {
      owner.syncing = false
    }
  }

  async dispose() {
    this.closed = true
    clearTimeout(this.retry)
    this.owner = this.topic = undefined
    await (await this.bridge?.catch(() => undefined))?.close()
    this.bridge = undefined
  }
}

export const desktopBrainApp = new BrainAppService(createBrainBridge, launchedDesktopOwnsBrain)
