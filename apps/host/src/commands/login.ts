import {
  CONTROL_LIMITS,
  formatUserCode,
  parseEnrollmentCreateRequest,
} from '@phosphor/shared/control-api'
import { EXIT } from '../checks'
import { ControlFailure } from '../control/client'
import {
  traceCommand,
  confirmedLine,
  withCommandLock,
  controlResult,
  prepareControl,
  waitForPoll,
  type CommandResult,
  type ControlContext,
} from '../control/command'
import { identityDirectory, IdentityFailure, type PendingEnrollment } from '../control/identity'
import { freshKey, publicIdentity } from '../control/signer'
import { HOST_VERSION } from '../version'

/** Whole minutes, rounded up, so a resumed code never claims more time than it has. */
export function minutesLeft(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000))
  return minutes === 1 ? '1 minute' : `${minutes} minutes`
}

async function runLoginCommand(context: ControlContext): Promise<CommandResult> {
  try {
    return await withCommandLock(context, async () => {
      const { loaded, client, store, url } = await prepareControl(context, true)
      context.log?.('host', 'login', {
        controlUrl: new URL(url).origin,
        label: context.hostname,
        hostVersion: HOST_VERSION,
        trace: context.trace,
      })
      if (loaded) {
        try {
          const server = await client.self(loaded.identity.hostId, loaded.key)
          await store.removePending()
          return { exitCode: EXIT.ok, message: confirmedLine(server) }
        } catch (error) {
          if (!(error instanceof ControlFailure) || error.code !== 'gone') throw error
          context.print('This machine was removed from the account. Starting a new enrollment.')
        }
      }
      const now = context.now ?? Date.now
      // Reaching here with an identity means the control plane said it is gone. Its
      // replacement's pending files are kept, so a cancelled or crashed replacement
      // resumes like any other; the old pair stays until the replacement is approved.
      let pending = await store.loadPending()
      if (
        !pending ||
        pending.enrollment.controlUrl !== url ||
        Date.parse(pending.enrollment.expiresAt) <= now()
      ) {
        await store.removePending()
        pending = null
      }
      const resuming = pending !== null
      if (!pending) {
        const key = freshKey()
        const { publicKey, keyFingerprint } = publicIdentity(key)
        const request = parseEnrollmentCreateRequest({
          publicKey,
          hostname: context.hostname,
          platform: context.platform,
          arch: context.arch ?? process.arch,
          hostVersion: HOST_VERSION,
        })
        if (!request.ok)
          throw new IdentityFailure('This machine has unsupported enrollment metadata.')
        const created = await client.enroll(request.value, key)
        if (created.keyFingerprint !== keyFingerprint) throw new ControlFailure('internal')
        context.log?.('host', 'enrollment.created', {
          enrollmentId: created.enrollmentId,
          keyFingerprint,
          expiresAt: created.expiresAt,
          trace: context.trace,
        })
        const enrollment: PendingEnrollment = {
          ...created,
          version: 1,
          controlUrl: url,
          savedAt: new Date(now()).toISOString(),
        }
        await store.savePending(enrollment, key, context.signal)
        pending = { enrollment, key }
      }
      const { enrollment, key } = pending
      const { publicKey, keyFingerprint } = publicIdentity(key)
      if (resuming) {
        context.log?.('host', 'enrollment.resumed', {
          enrollmentId: enrollment.enrollmentId,
          keyFingerprint,
          expiresAt: enrollment.expiresAt,
          trace: context.trace,
        })
        context.print('Resuming the earlier request.')
      }
      const deadline = Math.min(
        Date.parse(enrollment.expiresAt),
        now() + CONTROL_LIMITS.enrollmentTtlSec * 1000,
      )
      context.print(`To add this machine to your Phosphor account:
  1. Open Phosphor on a computer where you are signed in.
  2. Machines > Add a machine, and enter:  ${formatUserCode(enrollment.userCode)}
Key fingerprint: ${keyFingerprint}. Phosphor shows the same one.
Waiting for approval. The code expires in ${minutesLeft(deadline - now())}. Ctrl-C cancels.`)
      const expired = {
        exitCode: EXIT.tempfail,
        message: 'The code expired. Run phosphor setup again.',
      }
      let failures = 0
      for (let polls = 0; polls < CONTROL_LIMITS.enrollmentTtlSec; polls++) {
        if (context.signal?.aborted) throw new ControlFailure('offline')
        if (now() >= deadline) return expired
        await waitForPoll(
          context,
          Math.min(
            failures === 0
              ? enrollment.pollIntervalSec * 1000
              : Math.min(enrollment.pollIntervalSec * 1000 * 2 ** Math.min(failures, 5), 30_000),
            deadline - now(),
          ),
        )
        if (context.signal?.aborted) throw new ControlFailure('offline')
        if (now() >= deadline) return expired
        let answer
        try {
          answer = await client.poll(enrollment.enrollmentId, publicKey, key)
          context.log?.('host', 'enrollment.poll', {
            enrollmentId: enrollment.enrollmentId,
            result: answer.status,
            trace: context.trace,
          })
          failures = 0
        } catch (error) {
          if (error instanceof ControlFailure) {
            if (['gone', 'not-found', 'forbidden'].includes(error.code)) await store.removePending()
            if (['offline', 'unavailable', 'internal', 'too-many-requests'].includes(error.code)) {
              if (context.signal?.aborted) throw error
              if (failures === 0)
                context.print(
                  'The control plane is not answering; still trying until the code expires.',
                )
              failures++
              continue
            }
          }
          throw error
        }
        if (answer.status === 'expired') {
          await store.removePending()
          return expired
        }
        if (answer.status === 'pending') continue
        if (context.signal?.aborted) throw new ControlFailure('offline')
        // Drop the revoked pair first, so a crash before the commit leaves no
        // host.json and the next login can reuse the saved key (identity.ts).
        context.log?.('host', 'enrollment.approved', {
          hostId: answer.hostId,
          ownerLogin: answer.owner.login,
          trace: context.trace,
        })
        if (loaded) await store.remove(loaded.identity.hostId)
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
        context.log?.('host', 'identity.saved', {
          path: identityDirectory(context.configPath) + '/host.json',
          trace: context.trace,
        })
        await store.removePending()
        try {
          const server = await client.self(answer.hostId, key)
          return { exitCode: EXIT.ok, message: confirmedLine(server) }
        } catch (error) {
          if (error instanceof ControlFailure && error.code === 'gone') {
            await store.remove(answer.hostId)
            return controlResult(error)
          }
          return {
            exitCode: EXIT.ok,
            message: `${confirmedLine(answer)}\nSaved. Phosphor could not confirm it yet; phosphor status will check again.`,
          }
        }
      }
      return expired
    })
  } catch (error) {
    if (context.signal?.aborted)
      return {
        exitCode: 130,
        message: "Cancelled. Run phosphor setup again within the code's lifetime to keep waiting.",
      }
    return controlResult(error, context.signal)
  }
}

export function runLogin(context: ControlContext) {
  return traceCommand(context, 'login', (context) => runLoginCommand(context))
}
