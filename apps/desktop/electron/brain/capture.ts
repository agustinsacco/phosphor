import type {
  SessionUserInput,
  SessionInputReceipt,
} from '@phosphor/session-runtime/pi/session-startup'
import { readCaptureSnapshot, type CaptureIdentity, type CaptureSnapshot } from './capture-snapshot'
import type { BrainCapture } from '@phosphor/shared/brain'
import type { LiveSession } from '@phosphor/session-runtime/pi/session-registry'
import { extractText } from '@phosphor/session-runtime/pi/session-content'
import type { PiEvent } from '@phosphor/shared/rpc'
import type { DesktopMemoryClient } from './memory-client'
import { bounded, laneAuthority } from './authority'

interface Entry {
  type?: string
  id?: string
  parentId?: string | null
  timestamp?: string
  message?: { role?: string; content?: unknown; customType?: unknown; source?: unknown }
}
export function newUserCaptures(
  entries: unknown[],
  seen: Set<string>,
  authority: { scope: string; branch: string },
  sessionId: string,
): BrainCapture[] {
  bounded(entries, 1_000_000)
  if (entries.length > 4000) throw new Error('Brain capture entry budget exceeded')
  const known = new Set(seen)
  const result: BrainCapture[] = []
  for (const raw of entries) {
    const entry = raw as Entry | null
    if (!entry || typeof entry.id !== 'string' || entry.id.length > 200)
      throw new Error('Ambiguous Brain entry identity')
    if (seen.has(entry.id)) continue
    if (
      entry.parentId !== null &&
      (typeof entry.parentId !== 'string' || !known.has(entry.parentId))
    )
      continue
    seen.add(entry.id)
    known.add(entry.id)
    const message = entry.message
    if (
      entry.type !== 'message' ||
      message?.role !== 'user' ||
      message.customType ||
      message.source
    )
      continue
    if (
      typeof message.content !== 'string' &&
      (!Array.isArray(message.content) ||
        !message.content.every(
          (part: { type?: string; text?: unknown }) =>
            part?.type === 'text' && typeof part.text === 'string',
        ))
    )
      continue
    const text = extractText(message.content)
    const observedAt = Date.parse(entry.timestamp ?? '')
    if (!text || text.length > 16_000 || !Number.isSafeInteger(observedAt) || observedAt < 0)
      continue
    result.push({
      ...authority,
      sessionId,
      entryId: entry.id,
      parentId: entry.parentId ?? null,
      rootIds: [entry.id],
      role: 'user',
      label: 'New user message',
      observedAt,
      text,
    })
  }
  return result
}

interface PendingInput {
  text: string
  authority: { scope: string; branch: string }
  admittedAt: number
  accepted: boolean
}
export type BrainCaptureObserver = (() => void) & {
  beforeInput(command: SessionUserInput): Promise<SessionInputReceipt | undefined>
}

/** Only service-admitted, uniquely matching new input is eligible; events alone authorize nothing. */
export async function attachBrainCapture(
  live: LiveSession,
  store: DesktopMemoryClient,
  epoch: number,
  onError: (error: unknown) => void,
): Promise<BrainCaptureObserver> {
  if (live.owner) throw new Error('Processor sessions cannot be captured')
  const capture = new InputCapture(live, store, epoch, onError)
  try {
    await capture.initialize()
  } catch (error) {
    capture.dispose()
    throw error
  }
  return Object.assign(capture.dispose, { beforeInput: capture.beforeInput })
}
class InputCapture {
  constructor(
    private readonly live: LiveSession,
    private readonly store: DesktopMemoryClient,
    private readonly epoch: number,
    private readonly onError: (error: unknown) => void,
  ) {
    this.path = live.client.sessionFile
    live.client.on('session-file', this.fileChanged)
  }
  private identity?: CaptureIdentity
  private path?: string
  private seen = new Set<string>()
  private pending: PendingInput[] = []
  private disposed = false
  private tail = Promise.resolve()
  initialize = async (): Promise<void> => {
    const snapshot = await readCaptureSnapshot(this.live)
    if (this.disposed) throw new Error('Brain capture identity changed during baseline')
    this.identity = snapshot.identity
    this.remember(snapshot.entries)
    this.live.client.on('event', this.schedule)
  }
  private remember(entries: unknown[]): void {
    for (const raw of entries) this.seen.add((raw as Entry).id!)
  }
  private fileChanged = (path: string): void => {
    if (this.path && this.path !== path) this.fail(new Error('Brain capture identity changed'))
    this.path = path
  }
  private fail = (error: unknown): void => {
    this.dispose()
    this.onError(error)
  }
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run)
    this.tail = result.then(
      () => {},
      (error: unknown) => this.fail(error),
    )
    return result
  }
  private allowed = async (): Promise<boolean> => {
    if (this.disposed) return false
    const snapshot = await this.store.snapshot()
    if (!snapshot.prefs.enabled || snapshot.policyEpoch !== this.epoch) {
      this.dispose()
      return false
    }
    return true
  }
  private consume = async (snapshot: CaptureSnapshot): Promise<void> => {
    if (!(await this.allowed())) return
    const inputs = this.pending.filter((input) => input.accepted)
    const candidates = inputs.length
      ? newUserCaptures(
          snapshot.entries,
          new Set(this.seen),
          inputs[0]!.authority,
          snapshot.identity.sessionId,
        )
      : []
    const matches = (candidate: BrainCapture, input: PendingInput): boolean =>
      candidate.text === input.text && candidate.observedAt >= input.admittedAt
    for (const candidate of candidates) {
      const possible = inputs.filter((input) => matches(candidate, input))
      if (
        possible.length !== 1 ||
        candidates.filter((item) => matches(item, possible[0]!)).length !== 1
      )
        continue
      if (!(await this.allowed())) return
      await this.store.captureAt(this.epoch, { ...candidate, ...possible[0]!.authority })
    }
    this.pending = this.pending.filter(
      (input) => !candidates.some((candidate) => matches(candidate, input)),
    )
    this.remember(snapshot.entries)
  }
  beforeInput = (command: SessionUserInput): Promise<SessionInputReceipt | undefined> =>
    this.enqueue(async () => {
      if (!(await this.allowed())) return undefined
      if (
        !command.message ||
        command.message.length > 16000 ||
        command.message.trimStart().startsWith('/') ||
        command.images?.length
      )
        return undefined
      await this.consume(await readCaptureSnapshot(this.live, this.identity))
      const authority = await laneAuthority(this.live.workspacePath)
      const snapshot = await this.store.snapshot()
      if (
        this.disposed ||
        snapshot.policyEpoch !== this.epoch ||
        !snapshot.prefs.workspaces.includes(authority.scope)
      )
        return undefined
      if (this.pending.length >= 32) throw new Error('Brain pending input budget exceeded')
      const input: PendingInput = {
        text: command.message,
        authority,
        admittedAt: Date.now(),
        accepted: false,
      }
      this.pending.push(input)
      let completed = false
      return {
        complete: (response) =>
          this.enqueue(async () => {
            if (completed || this.disposed) return
            completed = true
            const disposition =
              response?.success && response.type === 'response' && response.command === command.type
                ? (response.data as { disposition?: unknown } | undefined)?.disposition
                : undefined
            if (
              disposition !== 'queued' &&
              !(command.type === 'prompt' && disposition === 'started')
            )
              this.pending = this.pending.filter((item) => item.text !== input.text)
            else input.accepted = true
            await this.scan()
          }),
      }
    })
  private scan = async (): Promise<void> => {
    if (await this.allowed())
      await this.consume(await readCaptureSnapshot(this.live, this.identity))
  }
  private schedule = (event: PiEvent): void => {
    if (event.type === 'agent_end') this.enqueue(this.scan).catch(() => {})
  }
  dispose = (): void => {
    this.disposed = true
    this.pending = []
    this.live.client.off('event', this.schedule)
    this.live.client.off('session-file', this.fileChanged)
  }
}
