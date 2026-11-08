import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { JsonlDecoder } from '@phosphor/session-runtime/pi/jsonl'
import { runPrintMode } from '@phosphor/session-runtime/pi/print-mode'
import type { BrainJob } from '@phosphor/shared/brain'
import type { ForkLaunch } from './types'
import type { LaneMeta } from './lane'

export interface ForkInput {
  directory: string
  job: BrainJob
  lane: LaneMeta
  launch: ForkLaunch
  guardExtension: string
  prompt: string
  signal: AbortSignal
}
export interface ForkResult {
  text: string
  usage: { tokens: number; cost: number }
}
interface AssistantEnd {
  type?: string
  message?: {
    role?: string
    stopReason?: string
    content?: { type: string; text?: string }[]
    usage?: { totalTokens?: number; cost?: { total?: number } }
  }
}

function forkArgs(input: ForkInput, directory: string): string[] {
  const thinking = ['off', 'minimal', 'low'].includes(input.lane.thinking)
    ? input.lane.thinking
    : 'low'
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
    thinking,
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

function answer(
  message: NonNullable<AssistantEnd['message']>,
): ForkResult & { stopReason?: string } {
  const text = Array.isArray(message.content)
    ? message.content
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
    : ''
  return {
    text,
    stopReason: message.stopReason,
    usage: { tokens: message.usage?.totalTokens ?? 0, cost: message.usage?.cost?.total ?? 0 },
  }
}

export async function runFork(
  input: ForkInput,
  run: typeof runPrintMode = runPrintMode,
): Promise<ForkResult> {
  const { job, lane, launch, signal } = input
  const directory = join(input.directory, 'forks', job.id)
  await mkdir(directory, { recursive: true })
  const decoder = new JsonlDecoder()
  let last: (ForkResult & { stopReason?: string }) | undefined
  const consume = (lines: string[]): void => {
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as AssistantEnd
        if (event?.type === 'message_end' && event.message?.role === 'assistant')
          last = answer(event.message)
      } catch {
        // Non-protocol diagnostic lines do not become the extracted answer.
      }
    }
  }
  try {
    const result = await run(launch.binaryPath, forkArgs(input, directory), {
      cwd: existsSync(lane.cwd) ? lane.cwd : directory,
      env: {
        ...launch.env,
        PI_OFFLINE: '1',
        PI_CLAUDE_CLI_EPHEMERAL: '1',
        PI_CLAUDE_CLI_STATE_DIR: join(directory, 'provider'),
      },
      timeoutMs: 150_000,
      signal,
      maxOutputBytes: 0,
      stderr: 'ignore',
      onStdout: (chunk) => consume(decoder.push(chunk)),
    })
    consume(decoder.end())
    signal.throwIfAborted()
    if (result.reason) throw new Error(`Knowledge extraction ${result.reason}.`)
    if (last?.stopReason === 'error' || last?.stopReason === 'aborted')
      throw new Error(`Knowledge extraction ${last.stopReason}.`)
    if (!last?.text.trim()) throw new Error('Knowledge extraction returned no text.')
    return { text: last.text, usage: last.usage }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
