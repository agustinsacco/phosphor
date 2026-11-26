import { useChatStore } from './chat'

/**
 * Bootstrap reads a Host runs at once. Each costs it five calls, and a
 * connection takes at most 32 pending: a reconnect showing many open lanes
 * running must leave room for their stream resyncs and for the user.
 */
const HOST_READS = 3

type Flight = { done: Promise<boolean>; retry?: Promise<boolean> }
const flights = new Map<string, Flight>()
const hosts = new Map<string, { busy: number; waiting: (() => void)[] }>()

/** One of the Host's read slots, at once when free; an urgent read goes to the front of the line. */
function hostSlot(hostId: string, urgent: boolean): (() => void) | Promise<() => void> {
  let host = hosts.get(hostId)
  if (!host) hosts.set(hostId, (host = { busy: 0, waiting: [] }))
  const slots = host
  const take = (): (() => void) => {
    slots.busy++
    let released = false
    return () => {
      if (released) return
      released = true
      slots.busy--
      const next = slots.waiting.shift()
      if (next) next()
      else if (slots.busy === 0) hosts.delete(hostId)
    }
  }
  if (slots.busy < HOST_READS) return take()
  return new Promise((resolve) => {
    const go = () => resolve(take())
    if (urgent) slots.waiting.unshift(go)
    else slots.waiting.push(go)
  })
}

/** pi's state or models are missing: a read was refused, failed, or predated its start. */
function incomplete(sessionId: string): boolean {
  const chat = useChatStore.getState().sessions[sessionId]
  return !!chat && (!chat.meta || chat.modelsFailed)
}

export type BootstrapOptions = {
  /** Read again after any read in flight, which may predate a new pi or session file. */
  fresh?: boolean
}

/**
 * One bootstrap read per session at a time: adoption, a stream reset and a
 * lane's pi starting all ask at once. A Host lane's read also waits for one
 * of its Host's slots; This Mac's in-app sessions never wait. A caller that
 * joins a Host lane's read in flight, which a refusal left incomplete, shares
 * one more read after it.
 */
export function sharedBootstrap(
  sessionId: string,
  read: () => Promise<boolean>,
  context: { hostId: string | undefined; isOpen: () => boolean },
  options: BootstrapOptions = {},
): Promise<boolean> {
  const flight = flights.get(sessionId)
  if (flight && !options.fresh) {
    if (!context.hostId) return flight.done
    flight.retry ??= flight.done.then((ok) =>
      context.isOpen() && incomplete(sessionId)
        ? sharedBootstrap(sessionId, read, context, { fresh: true })
        : ok,
    )
    return flight.retry
  }
  const { hostId } = context
  const run = (): Promise<boolean> => {
    if (!hostId) return read()
    const readIn = (release: () => void) =>
      (context.isOpen() ? read() : Promise.resolve(false)).finally(release)
    const slot = hostSlot(hostId, !!options.fresh)
    // A free slot reads now, so a read's first call goes out with its caller's.
    return typeof slot === 'function' ? readIn(slot) : slot.then(readIn)
  }
  const next: Flight = {
    done: (flight ? flight.done.catch(() => false).then(run) : run()).finally(() => {
      if (flights.get(sessionId) === next) flights.delete(sessionId)
    }),
  }
  flights.set(sessionId, next)
  return next.done
}
