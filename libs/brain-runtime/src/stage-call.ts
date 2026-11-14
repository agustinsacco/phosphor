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
import { RECONCILE_SYSTEM } from './stage-prompts/reconcile'
import { scrubExcerpt } from '@phosphor/memory-engine/secrets'
import { callThinking, type CallTrace } from './call-trace'
import { setTimeout as delay } from 'node:timers/promises'

const SYSTEM = {
  extract: EXTRACTION_SYSTEM,
  identity: IDENTITY_SYSTEM,
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
        thinking: callThinking(lane.thinking),
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

function retryable(reason: CallTrace['reason'] | undefined): boolean {
  return reason === 'error' || reason === 'no-text' || reason === 'exit' || reason === 'spawn'
}

export async function stageCaller(context: CallContext): Promise<StageAsk> {
  const { job, store, record, signal, options } = context
  const execute = await callExecutor(context)
  const nextPart = (stage: BrainExtractionCall['stage']): number =>
    Math.max(0, ...record.record.calls.filter((c) => c.stage === stage).map((c) => c.part)) + 1
  const run = async (
    stage: BrainExtractionCall['stage'],
    prompt: string,
    system: string,
    entryIds: string[],
    metadata: unknown,
  ): Promise<{ answer: string; part: number }> => {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted()
      const part = nextPart(stage)
      store.savePart(job.id, {
        part: `input:${stage}:${part}`,
        inputHash: inputHash(prompt),
        output: scrubExcerpt(JSON.stringify(metadata)),
      })
      try {
        return { answer: await execute(stage, part, prompt, system, entryIds), part }
      } catch (error) {
        const reason = record.record.calls.at(-1)?.trace?.reason
        if (attempt || !retryable(reason)) throw error
        signal.throwIfAborted()
        await (options.retryDelay ?? ((ms, signal) => delay(ms, undefined, { signal })))(
          2000,
          signal,
        )
      }
    }
  }
  return async (stage, _part, prompt, validate, entryIds = [], metadata: StageInput = {}) => {
    const { answer, part } = await run(stage, prompt, SYSTEM[stage], entryIds, metadata)
    try {
      return validate(answer)
    } catch (error) {
      const message = scrubExcerpt(error instanceof Error ? error.message : String(error))
      record.rejected(stage, part, message)
      const repair = repairPrompt(prompt, answer, message)
      const corrected = await run('repair', repair, SYSTEM[stage], entryIds, {
        stage,
        part,
        hash: inputHash(prompt),
        error: message,
      })
      try {
        return validate(corrected.answer)
      } catch (second) {
        record.rejected(
          'repair',
          corrected.part,
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
