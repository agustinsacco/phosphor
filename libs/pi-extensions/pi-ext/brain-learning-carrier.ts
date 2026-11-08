import { timingSafeEqual } from 'node:crypto'
import { dirname, join } from 'node:path'
import { claimBrainSession, type BrainOwnership } from './brain-processor'
import {
  readCarrierFile,
  writeCarrierFile,
  carrierErrorMessage,
  carrierErrorUsage,
} from './brain-learning-carrier-files'
import {
  createLearningCarrierOperation,
  validateCarrierControl,
  type LearningCarrierControl,
  type LearningCarrierContext,
} from './brain-learning-carrier-operation'
import { installedLearningSdk, type LearningPiSdk } from './brain-learning-carrier-sdk'

import { BRAIN_LEARNING_COMMAND, BRAIN_LEARNING_STATUS_KEY } from './status-keys'
export const LEARNING_CARRIER_COMMAND = BRAIN_LEARNING_COMMAND
export const LEARNING_CARRIER_STATUS = BRAIN_LEARNING_STATUS_KEY
export interface LearningCarrierApi {
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void
  appendEntry(type: string, data: unknown): void
  getActiveTools(): string[]
  getAllTools(): unknown[]
  registerCommand(
    name: string,
    options: {
      description: string
      handler(args: string, ctx: LearningCarrierContext): Promise<void>
    },
  ): void
}
function assertControlOwner(ctx: LearningCarrierContext, jobId: string): void {
  const rows = ctx.sessionManager.getBranch() as Array<{
    type?: string
    customType?: string
    data?: { kind?: string; jobId?: string }
  }>
  const owners = rows.filter((row) => row.customType === 'phosphor-brain-owner')
  if (
    !owners.length ||
    owners.some(
      (row) => row.type !== 'custom' || row.data?.kind !== 'brain' || row.data.jobId !== jobId,
    )
  )
    throw new Error('Learning control ownership changed')
}
/** A command/status transport only. No tools, prompt scheduler, context resets or model loop. */
export function registerLearningCarrier(
  pi: LearningCarrierApi,
  controlFile: string,
  jobId: string,
  nonce: string,
  loadSdk: () => Promise<LearningPiSdk> = installedLearningSdk,
): void {
  if (!/^[\w-]{1,128}$/.test(jobId) || !/^[a-f0-9]{64}$/.test(nonce))
    throw new Error('Learning carrier requires a job-bound nonce')
  let ownership: BrainOwnership = 'pending',
    active = false
  let operation: ReturnType<typeof createLearningCarrierOperation> | undefined
  const controller = new AbortController()
  const assertOwned = (ctx: LearningCarrierContext): void => {
    assertControlOwner(ctx, jobId)
    if (ownership !== 'owned' || pi.getActiveTools().length || pi.getAllTools().length)
      throw new Error('Learning carrier requires private ownership and no executable tools')
  }
  pi.on('session_start', (_event, raw) => {
    const ctx = raw as LearningCarrierContext
    ownership = claimBrainSession(pi, ctx.sessionManager.getBranch(), jobId)
    assertOwned(ctx)
  })
  pi.on('session_shutdown', () => controller.abort())
  // Unknown input must terminate as handled, not fall through into ordinary agent inference.
  pi.on('input', () => ({ action: 'handled' }))
  pi.on('before_agent_start', () => {
    throw new Error('Learning carrier forbids the agent prompt loop')
  })
  pi.registerCommand(LEARNING_CARRIER_COMMAND, {
    description: 'Authenticated private learning control; never an inference prompt.',
    handler: async (args, ctx) => {
      const parts = args.split(' '),
        supplied = parts[0] ?? '',
        verb = parts[1]
      if (
        parts.length !== 2 ||
        !/^[a-f0-9]{64}$/.test(supplied) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(nonce)) ||
        !['prepare', 'run'].includes(verb ?? '')
      )
        throw new Error('Learning carrier command authentication failed')
      assertOwned(ctx)
      if (active) throw new Error('Learning carrier operation already active')
      active = true
      const root = dirname(controlFile)
      let ok = false
      try {
        if (!operation) {
          const control = JSON.parse(await readCarrierFile(controlFile)) as LearningCarrierControl
          validateCarrierControl(control, controlFile, jobId, nonce)
          operation = createLearningCarrierOperation(
            control,
            root,
            await loadSdk(),
            controller.signal,
            () => assertOwned(ctx),
          )
        }
        await operation(verb as 'prepare' | 'run', ctx)
        ok = true
      } catch (error) {
        await writeCarrierFile(join(root, `${verb}-error.json`), {
          error: carrierErrorMessage(error),
          usage: carrierErrorUsage(error),
        })
      } finally {
        active = false
        ctx.ui.setStatus(
          LEARNING_CARRIER_STATUS,
          JSON.stringify({ version: 1, nonce, jobId, operation: verb, ok }),
        )
      }
    },
  })
}
export default function brainLearningCarrier(pi: LearningCarrierApi): void {
  const control = process.env.PHOSPHOR_LEARNING_CONTROL
  if (!control) throw new Error('Learning carrier requires private host control')
  registerLearningCarrier(
    pi,
    control,
    process.env.PHOSPHOR_BRAIN_JOB_ID ?? '',
    process.env.PHOSPHOR_LEARNING_NONCE ?? '',
  )
}
