import {
  CONTROL_LIMITS,
  formatUserCode,
  parseEnrollmentCreateRequest,
} from '@phosphor/shared/control-api'
import { EXIT } from '../checks'
import { ControlFailure } from '../control/client'
import {
  confirmedLine,
  controlResult,
  prepareControl,
  waitForPoll,
  type CommandResult,
  type ControlContext,
} from '../control/command'
import { IdentityFailure } from '../control/identity'
import { freshKey, publicIdentity } from '../control/signer'
import { HOST_VERSION } from '../version'

export async function runLogin(context: ControlContext): Promise<CommandResult> {
  try {
    const { loaded, client, store, url } = await prepareControl(context, true)
    if (loaded) {
      try {
        const server = await client.self(loaded.identity.hostId, loaded.key)
        return { exitCode: EXIT.ok, message: confirmedLine(server) }
      } catch (error) {
        if (!(error instanceof ControlFailure) || error.code !== 'gone') throw error
        context.print('This machine was removed from the account. Starting a new enrollment.')
      }
    }
    const key = freshKey()
    const { publicKey, keyFingerprint } = publicIdentity(key)
    const request = parseEnrollmentCreateRequest({
      publicKey,
      hostname: context.hostname,
      platform: context.platform,
      arch: context.arch ?? process.arch,
      hostVersion: HOST_VERSION,
    })
    if (!request.ok) throw new IdentityFailure('This machine has unsupported enrollment metadata.')
    const enrollment = await client.enroll(request.value, key)
    if (enrollment.keyFingerprint !== keyFingerprint) throw new ControlFailure('internal')
    const now = context.now ?? Date.now
    const deadline = Math.min(
      Date.parse(enrollment.expiresAt),
      now() + CONTROL_LIMITS.enrollmentTtlSec * 1000,
    )
    context.print(`To add this machine to your Phosphor account:
  1. Open Phosphor on a computer where you are signed in.
  2. Machines > Add a machine, and enter:  ${formatUserCode(enrollment.userCode)}
Key fingerprint: ${keyFingerprint}. Phosphor shows the same one.
Waiting for approval. The code expires in 10 minutes. Ctrl-C cancels.`)
    const expired = {
      exitCode: EXIT.tempfail,
      message: 'The code expired. Run phosphor login again.',
    }
    for (let polls = 0; polls < CONTROL_LIMITS.enrollmentTtlSec; polls++) {
      if (context.signal?.aborted) throw new ControlFailure('offline')
      if (now() >= deadline) return expired
      await waitForPoll(context, Math.min(enrollment.pollIntervalSec * 1000, deadline - now()))
      if (context.signal?.aborted) throw new ControlFailure('offline')
      if (now() >= deadline) return expired
      const answer = await client.poll(enrollment.enrollmentId, publicKey, key)
      if (answer.status === 'expired') return expired
      if (answer.status === 'pending') continue
      if (context.signal?.aborted) throw new ControlFailure('offline')
      await store.save(
        {
          version: 1,
          controlUrl: url,
          hostId: answer.hostId,
          label: answer.label,
          ownerLogin: answer.owner.login,
          savedAt: new Date(now()).toISOString(),
        },
        key,
        context.signal,
      )
      try {
        const server = await client.self(answer.hostId, key)
        return { exitCode: EXIT.ok, message: confirmedLine(server) }
      } catch (error) {
        if (error instanceof ControlFailure && error.code === 'gone') {
          await store.remove()
          return controlResult(error)
        }
        return {
          exitCode: EXIT.ok,
          message: `${confirmedLine(answer)}\nSaved. Phosphor could not confirm it yet; phosphor status will check again.`,
        }
      }
    }
    return expired
  } catch (error) {
    return controlResult(error, context.signal)
  }
}
