import type { BrainJob, BrainExtractionCall } from '@phosphor/shared/brain'
import type { BrainStore } from '@phosphor/memory-engine/types'
import type { BrainServiceOptions } from './types'
import type { LaneMeta } from './lane'
import type { StageAsk, StageInput } from './stage-types'
import { runModelCall } from './model-call'
import { inputHash } from './windows'
import { extractionAnswer } from './extraction-record'
import type { ExtractionRecord } from './extraction-record'
import { EXTRACTION_SYSTEM } from './stage-prompts/extract'
import { IDENTITY_SYSTEM } from './stage-prompts/identity'
import { PARENTS_SYSTEM } from './stage-prompts/parents'
import { RECONCILE_SYSTEM } from './stage-prompts/reconcile'
import { scrubExcerpt } from './secrets'
import { callThinking } from './call-trace'
import { ANSWER_BYTES } from './constants'

const SYSTEM = {
  extract: EXTRACTION_SYSTEM,
  identity: IDENTITY_SYSTEM,
  parents: PARENTS_SYSTEM,
  reconcile: RECONCILE_SYSTEM,
}
export function repairPrompt(prompt: string, answer: string, error: string): string {
  return `${prompt}\n\nYour previous answer was invalid:\n${answer}\nValidation errors:\n${error}\nReturn a full corrected JSON answer, not a patch.`
}
interface CallContext {
  job: BrainJob
  lane: LaneMeta
  store: BrainStore
  options: BrainServiceOptions
  signal: AbortSignal
  record: ExtractionRecord
}
async function callExecutor(context: CallContext) {
  const { job, lane, store, options, signal, record } = context
  const launch = await options.lanes.launch(job.sessionPath)
  const usage = { ...(store.job(job.id)?.usage ?? { tokens: 0, cost: 0 }) }
  const run = options.runModelCall ?? runModelCall
  const execute = async (
    stage: BrainExtractionCall['stage'],
    part: number,
    prompt: string,
    systemPrompt: string,
    entryIds: string[],
  ) => {
    signal.throwIfAborted()
    const call: BrainExtractionCall = {
      stage,
      part,
      entryIds,
      inputHash: inputHash(prompt),
      answer: '',
      trace: null,
      error: null,
    }
    try {
      const result = await run({
        directory: options.directory,
        job,
        lane,
        launch,
        guardExtension: options.guardExtension,
        signal,
        stage,
        part,
        prompt,
        systemPrompt,
        thinking: callThinking(
          lane.thinking,
          systemPrompt === EXTRACTION_SYSTEM ? 'extract' : stage,
        ),
        onAnswer: (answer) => {
          call.answer = extractionAnswer(answer)
        },
        onTrace: (trace, diagnostic) => {
          call.trace = trace
          if (trace.reason !== 'completed' && diagnostic) call.error = diagnostic
        },
      })
      call.answer = extractionAnswer(result.text)
      usage.tokens += result.usage.tokens
      usage.cost += result.usage.cost
      if (store.job(job.id)) store.updateJob(job.id, { usage: { ...usage } })
      return result.text
    } catch (error) {
      call.error = scrubExcerpt(
        `${error instanceof Error ? error.message : String(error)}${call.error ? `: ${call.error}` : ''}`,
      )
      if (call.trace && store.job(job.id)) {
        usage.tokens += call.trace.usage.tokens
        usage.cost += call.trace.usage.cost
        store.updateJob(job.id, { usage: { ...usage } })
      }
      throw error
    } finally {
      record.call(call)
    }
  }
  return execute
}

export async function stageCaller(context: CallContext): Promise<StageAsk> {
  const { job, store, record } = context
  const execute = await callExecutor(context)
  const nextPart = (stage: BrainExtractionCall['stage']): number =>
    Math.max(0, ...record.record.calls.filter((c) => c.stage === stage).map((c) => c.part)) + 1
  return async (stage, _part, prompt, validate, entryIds = [], metadata: StageInput = {}) => {
    const part = nextPart(stage)
    const hash = inputHash(prompt),
      encoded = scrubExcerpt(JSON.stringify(metadata))
    if (Buffer.byteLength(encoded) <= ANSWER_BYTES)
      store.savePart(job.id, { part: `input:${stage}:${part}`, inputHash: hash, output: encoded })
    const answer = await execute(stage, part, prompt, SYSTEM[stage], entryIds)
    try {
      return validate(answer)
    } catch (error) {
      const message = scrubExcerpt(error instanceof Error ? error.message : String(error))
      record.rejected(stage, part, message)
      const repair = repairPrompt(prompt, answer, message)
      const repairPart = nextPart('repair')
      store.savePart(job.id, {
        part: `input:repair:${repairPart}`,
        inputHash: inputHash(repair),
        output: JSON.stringify({ stage, part, hash, error: message }),
      })
      const corrected = await execute('repair', repairPart, repair, SYSTEM[stage], entryIds)
      try {
        return validate(corrected)
      } catch (second) {
        record.rejected(
          'repair',
          repairPart,
          scrubExcerpt(second instanceof Error ? second.message : String(second)),
        )
        throw new Error(
          `Brain ${stage} validation failed after repair: ${second instanceof Error ? second.message : String(second)}`,
          { cause: second },
        )
      }
    }
  }
}
