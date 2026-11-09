import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { JsonlDecoder } from '@phosphor/session-runtime/pi/jsonl'
import { runPrintMode } from '@phosphor/session-runtime/pi/print-mode'
import { claudeOneShotEnv } from '@phosphor/session-runtime/pi/provider-detect'
import type { BrainJob } from '@phosphor/shared/brain'
import type { ForkLaunch } from './types'
import type { LaneMeta } from './lane'
import {
  assistantUsage,
  forkThinking,
  ForkTracer,
  FORK_STDERR_BYTES,
  FORK_TIMEOUT_MS,
  traceDiagnostic,
  type AssistantMessage,
  type ForkEvent,
  type ForkTrace,
} from './fork-trace'

export interface ForkInput {
  directory: string
  job: BrainJob
  lane: LaneMeta
  launch: ForkLaunch
  guardExtension: string
  prompt: string
  signal: AbortSignal
  /** Called once after cleanup; the caller must log diagnostics only on job failure. */
  onTrace?: (trace: ForkTrace, diagnostic?: string) => void
  /** Raw final text, including on transport or assistant failure; never diagnostics. */
  onAnswer?: (answer: string) => void
}
export interface ForkResult {
  text: string
  usage: { tokens: number; cost: number }
}
interface ForkAnswer extends ForkResult {
  stopReason?: string
}

function forkArgs(input: ForkInput, directory: string): string[] {
  return [
    ...input.launch.prefixArgs,
    '-p',
    '--mode',
    'json',
    '--fork',
    input.job.sessionPath,
    '--session-dir',
    directory,
    '--model',
    input.lane.model,
    '--thinking',
    forkThinking(input.lane.thinking),
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
    input.prompt,
  ]
}

function answer(message: AssistantMessage): ForkAnswer {
  const text = Array.isArray(message.content)
    ? message.content
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
    : ''
  return { text, stopReason: message.stopReason, usage: assistantUsage(message.usage) }
}

function forkStream(tracer: ForkTracer) {
  const decoder = new JsonlDecoder()
  let last: ForkAnswer | undefined
  const consume = (lines: string[]): void => {
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as ForkEvent
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

export async function runFork(
  input: ForkInput,
  run: typeof runPrintMode = runPrintMode,
): Promise<ForkResult> {
  const { job, lane, launch, signal } = input
  const directory = join(input.directory, 'forks', job.id)
  const tracer = new ForkTracer()
  const stream = forkStream(tracer)
  let reason: ForkTrace['reason'] = 'error'
  let diagnostic: string | undefined
  let finalText = ''
  try {
    await mkdir(directory, { recursive: true })
    const result = await run(launch.binaryPath, forkArgs(input, directory), {
      cwd: existsSync(lane.cwd) ? lane.cwd : directory,
      env: {
        ...launch.env,
        // A lane parks its Claude process for an hour; a parked fork would never exit.
        ...claudeOneShotEnv(),
        PI_OFFLINE: '1',
        PI_CLAUDE_CLI_STATE_DIR: join(directory, 'provider'),
      },
      timeoutMs: FORK_TIMEOUT_MS,
      signal,
      maxOutputBytes: 0,
      stderr: 'capture',
      maxStderrBytes: FORK_STDERR_BYTES,
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
