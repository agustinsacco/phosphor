import { ownerCall } from '@phosphor/host-client/owner'
import { CONTROL_LIMITS } from '@phosphor/shared/control-api'
import type { DirectoryAlias } from '../hosts/dedupe'

type Result<T> = ({ ok: true } & T) | { ok: false; error: { code: string } }
interface EnrollmentPorts {
  hostId: string
  call: Parameters<typeof ownerCall>[0]['call']
  control: {
    lookupEnrollment(
      code: string,
    ): Promise<Result<{ hostname: string; keyFingerprint: string; expiresAt: string }>>
    approveEnrollment(
      code: string,
      label: string,
    ): Promise<Result<{ machine: { id: string; keyFingerprint: string } }>>
    machines(): Promise<Result<{ machines: readonly { id: string }[] }>>
  }
  /** No side effect from an old account, disconnected owner or previous incarnation. */
  current(): boolean
  user: string | null
  directory(id: DirectoryAlias): void
  remember(id: string | null): void
  notice(message: string): void
  attempt: boolean
}

const LOCAL_OK = 'Local lanes are still available.'
const UNAVAILABLE = `Automatic enrollment could not finish. ${LOCAL_OK}`

async function approveLocal(p: EnrollmentPorts) {
  p.directory(undefined)
  const offer = await ownerCall(p, 'machine.enroll', { action: 'begin' })
  if (!p.current() || !('userCode' in offer)) return
  const found = await p.control.lookupEnrollment(offer.userCode)
  if (!p.current()) return
  if (
    !found.ok ||
    found.keyFingerprint !== offer.fingerprint ||
    !(Math.min(Date.parse(found.expiresAt), Date.parse(offer.expiresAt)) > Date.now())
  ) {
    p.directory(null)
    p.notice(found.ok ? `The enrollment code could not be verified. ${LOCAL_OK}` : UNAVAILABLE)
    return
  }
  const approved = await p.control.approveEnrollment(
    offer.userCode,
    found.hostname.slice(0, CONTROL_LIMITS.labelChars),
  )
  if (!p.current()) return
  if (approved.ok && approved.machine.keyFingerprint === offer.fingerprint) {
    // Control knows this id now; only machine.local can confirm it for next launch.
    p.directory(approved.machine.id)
    return
  }
  const conflict = !approved.ok && approved.error.code === 'conflict'
  // On an ambiguous network failure the daemon may already be polling a successful
  // approval. Keep the hold until machine.local next identifies the service.
  if (conflict) p.directory(null)
  p.notice(
    conflict
      ? `Control refused enrollment. The account may be at its machine limit. ${LOCAL_OK}`
      : UNAVAILABLE,
  )
}

/** Read the owner socket, not a directory guess. A signed-in account can approve only the local offer. */
export async function syncLocalEnrollment(p: EnrollmentPorts): Promise<void> {
  const status = await ownerCall(p, 'machine.local', undefined)
  if (!p.current() || status.machineId !== p.hostId || !status.ownerLock) return
  if (status.enrolled) {
    const { hostId } = status.enrolled
    p.directory(hostId)
    p.remember(hostId)
    if (p.user && p.attempt) {
      // Login names can change or be absent. The immutable id must belong to this user's directory.
      const list = await p.control.machines()
      if (p.current() && list.ok && !list.machines.some((m) => m.id === hostId))
        p.notice(`This service is enrolled under another account. ${LOCAL_OK}`)
    }
    return
  }
  if (status.enrolled !== null || status.mode === 'enrolled') return
  if (status.mode !== 'enrolling') p.remember(null)
  if (!p.user || !p.attempt || status.ownerLock.standby) {
    if (status.mode !== 'enrolling') p.directory(null)
    return
  }
  await approveLocal(p)
}
