type Drafted = { draftAttachmentId?: string }

/** Remote attachments carry an id so a send can find its own in the draft later. */
export function withDraftIds<T extends Drafted>(items: T[], remote: boolean): T[] {
  if (!remote) return items
  return items.map((a) => ({ ...a, draftAttachmentId: a.draftAttachmentId ?? crypto.randomUUID() }))
}

/**
 * Remote sends waiting for their Host receipt. Their text and attachments stay
 * in the draft until then, so a second press must not resend them, but a new
 * message typed meanwhile (a follow-up after a steer) must still go out.
 */
export function createReceiptGuard() {
  const texts = new Set<string>()
  const ids = new Set<string>()
  return {
    /** The attachments not already waiting on a receipt. */
    fresh<T extends Drafted>(items: T[]): T[] {
      return items.filter((a) => !a.draftAttachmentId || !ids.has(a.draftAttachmentId))
    },
    isResend(message: string, fresh: readonly unknown[]): boolean {
      return texts.has(message) && fresh.length === 0
    },
    /** Marks a send as waiting; call the returned function once it settles. */
    hold(message: string, held: Iterable<string | undefined>): () => void {
      const mine = [...held].filter((id): id is string => !!id)
      texts.add(message)
      for (const id of mine) ids.add(id)
      return () => {
        texts.delete(message)
        for (const id of mine) ids.delete(id)
      }
    },
  }
}
