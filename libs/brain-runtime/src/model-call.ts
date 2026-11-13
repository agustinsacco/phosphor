import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { JsonlDecoder } from '@phosphor/session-runtime/pi/jsonl'
import { runPrintMode } from '@phosphor/session-runtime/pi/print-mode'
import { claudeOneShotEnv } from '@phosphor/session-runtime/pi/provider-detect'
import type { BrainJob, BrainExtractionCall } from '@phosphor/shared/brain'
import type { ModelLaunch } from './types'
import type { LaneMeta } from './lane'
import {
  assistantUsage,
  callThinking,
  CallTracer,
  CALL_STDERR_BYTES,
  CALL_TIMEOUT_MS,
  traceDiagnostic,
  type AssistantMessage,
  type CallEvent,
  type CallTrace,
} from './call-trace'

export interface ModelCallInput {
  directory: string
  job: BrainJob
  stage: BrainExtractionCall['stage']
  part: string | number
  systemPrompt: string
  thinking?: string
  lane: LaneMeta
  launch: ModelLaunch
  guardExtension: string
  prompt: string
  signal: AbortSignal
  /** Called once after cleanup; the caller must log diagnostics only on job failure. */
  onTrace?: (trace: CallTrace, diagnostic?: string) => void
  /** Raw final text, including on transport or assistant failure; never diagnostics. */
  onAnswer?: (answer: string) => void
}
export interface ModelCallResult {
  text: string
  usage: { tokens: number; cost: number }
}
interface ModelAnswer extends ModelCallResult {
  stopReason?: string
}

function modelArgs(input: ModelCallInput, directory: string): string[] {
  return [
    ...input.launch.prefixArgs,
    '-p',
    '--mode',
    'json',
    '--no-session',
    '--model',
    input.lane.model,
    '--thinking',
    callThinking(input.thinking ?? input.lane.thinking, input.stage),
    '--no-tools',
    '--no-mcp',
    '--no-skills',
    '--no-prompt-templates',
    '--no-context-files',
    '--no-themes',
    '--no-approve',
    '--offline',
    '-e',
    input.guardExtension,
    '--system-prompt',
    join(directory, 'system.md'),
  ]
}

function answer(message: AssistantMessage): ModelAnswer {
  const text = Array.isArray(message.content)
    ? message.content
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
    : ''
  return { text, stopReason: message.stopReason, usage: assistantUsage(message.usage) }
}

function callStream(tracer: CallTracer) {
  const decoder = new JsonlDecoder()
  let last: ModelAnswer | undefined
  const consume = (lines: string[]): void => {
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as CallEvent
        tracer.event(event)
        if (event?.type === 'message_end' && event.message?.role === 'assistant')
          last = answer(event.message)
      } catch {
        // Non-protocol diagnostic lines do not become the extracted answer.
      }
    }
  }
  return {
    stdout(chunk: string) {
      tracer.stdout()
      consume(decoder.push(chunk))
    },
    end() {
      consume(decoder.end())
      return last
    },
  }
}

export async function runModelCall(
  input: ModelCallInput,
  run: typeof runPrintMode = runPrintMode,
): Promise<ModelCallResult> {
  const { job, lane, launch, signal } = input
  const directory = join(input.directory, 'calls', job.id, `${input.stage}-${input.part}`)
  const tracer = new CallTracer()
  const stream = callStream(tracer)
  let reason: CallTrace['reason'] = 'error'
  let diagnostic: string | undefined
  let finalText = ''
  try {
    signal.throwIfAborted()
    await rm(directory, { recursive: true, force: true })
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(join(directory, 'system.md'), input.systemPrompt, { mode: 0o600 })
    const result = await run(launch.binaryPath, modelArgs(input, directory), {
      cwd: directory,
      input: input.prompt,
      env: {
        ...launch.env,
        // A lane parks its Claude process for an hour; a parked model call would never exit.
        ...claudeOneShotEnv(),
        PI_OFFLINE: '1',
        PI_CLAUDE_CLI_STATE_DIR: join(directory, 'provider'),
      },
      timeoutMs: CALL_TIMEOUT_MS,
      signal,
      maxOutputBytes: 0,
      stderr: 'capture',
      maxStderrBytes: CALL_STDERR_BYTES,
      onStdout: stream.stdout,
    })
    const last = stream.end()
    finalText = last?.text ?? ''
    if (result.stderr) diagnostic = traceDiagnostic(result.stderr)
    reason = signal.aborted ? 'aborted' : (result.reason ?? 'error')
    if (result.reason || signal.aborted) {
      diagnostic ??= traceDiagnostic(result.error ?? '')
      if (reason === 'timeout') throw new Error(tracer.timeoutMessage(lane.model))
      throw new Error(`Knowledge extraction ${reason}.`)
    }
    if (last?.stopReason === 'error' || last?.stopReason === 'aborted') {
      reason = last.stopReason
      throw new Error(`Knowledge extraction ${reason}.`)
    }
    if (!last?.text.trim()) {
      reason = 'no-text'
      throw new Error('Knowledge extraction returned no text.')
    }
    reason = 'completed'
    return { text: last.text, usage: last.usage }
  } finally {
    let cleaned = false
    try {
      await rm(directory, { recursive: true, force: true })
      cleaned = true
    } finally {
      tracer.finish(cleaned ? reason : 'error')
      input.onAnswer?.(finalText || stream.end()?.text || '')
      input.onTrace?.(tracer.trace, diagnostic)
    }
  }
}
