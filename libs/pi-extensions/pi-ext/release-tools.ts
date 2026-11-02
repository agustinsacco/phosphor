import { Type } from 'typebox'
import { MEMORY_MAX, recordState, type Claimant, type Run } from './release-lease'
import { checkPolicyUntouched, mergeArgs, type Policy } from './release-github'
import { ANSWER_MESSAGE } from './release-prompt'

/** Registered inactive; the model sees them only while this lane holds the lease. */
export const RELEASE_TOOLS = ['release_merge', 'release_memory', 'release_ask', 'release_flag']

/** What the tools need from the extension that owns the lease. */
export interface ReleaseRuntime {
  git: Run
  gh: Run
  /** Where this lane fetches the release ref. */
  local(): string
  /** This lane's session on this host, in this process. */
  claimant(): Claimant
  /** The epoch this lane holds, or undefined when it is not active. */
  epoch(): number | undefined
  policy(): Policy
  /** Serialize writes to the release ref. */
  exclusive<T>(work: () => Promise<T>): Promise<T>
  /** Make this run alert the user when it ends. */
  flag(): void
  /** Origin says another lane holds the lease. */
  lost(): void
  now(): number
}

interface ToolUi {
  ui: {
    select(
      title: string,
      options: string[],
      opts?: { timeout?: number },
    ): Promise<string | undefined>
  }
}

export interface ToolsApi {
  registerTool(definition: Record<string, unknown>): void
  sendMessage?(
    message: { customType: string; content: string; display: boolean },
    options?: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' | 'nextTurn' },
  ): void
}

const text = (value: string, details: Record<string, unknown> = {}) => ({
  content: [{ type: 'text' as const, text: value }],
  details,
})

function heldEpoch(runtime: ReleaseRuntime): number {
  const epoch = runtime.epoch()
  if (epoch === undefined)
    throw new Error('This lane does not hold the release lease. Change nothing on GitHub.')
  return epoch
}

async function merge(runtime: ReleaseRuntime, pr: number, head: string) {
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error('head must be a full commit SHA.')
  const epoch = heldEpoch(runtime)
  return runtime.exclusive(async () => {
    const { git } = runtime
    await checkPolicyUntouched(git, runtime.local(), pr, head, runtime.policy().base)
    // Renew the lease by compare-and-swap last, so nobody can take it between
    // this check and the merge without this write being refused.
    const renewed = await recordState(
      git,
      runtime.local(),
      runtime.claimant(),
      epoch,
      runtime.now(),
      {},
    )
    if (renewed !== 'ok') {
      runtime.lost()
      throw new Error(
        'Not merged: another lane holds the release lease. Change nothing on GitHub and end the pass.',
      )
    }
    const output = await runtime.gh(mergeArgs(pr, head, runtime.policy()))
    const event = `merged #${pr} at ${head.slice(0, 7)}`
    // The merge happened; a ledger line that fails to save must not hide it.
    const change = { event }
    await recordState(git, runtime.local(), runtime.claimant(), epoch, runtime.now(), change).catch(
      () => 'not-holder',
    )
    return text(`${event}. ${output.trim()}`.trim(), { pr, head })
  })
}

function registerMerge(pi: ToolsApi, runtime: ReleaseRuntime): void {
  pi.registerTool({
    name: 'release_merge',
    label: 'Release merge',
    description:
      'Merge a reviewed pull request. Refuses unless the head is still the commit you reviewed and it leaves the release policy alone, renews the release lease on origin, then merges that exact commit.',
    promptSnippet: 'Merge a reviewed pull request under the release lease',
    defaultActive: false,
    parameters: Type.Object({
      pr: Type.Integer({ minimum: 1, description: 'Pull request number' }),
      head: Type.String({ description: 'The full head commit SHA you reviewed' }),
    }),
    execute: (_id: string, params: { pr: number; head: string }) =>
      merge(runtime, params.pr, params.head),
  })
}

function registerMemory(pi: ToolsApi, runtime: ReleaseRuntime): void {
  pi.registerTool({
    name: 'release_memory',
    label: 'Release memory',
    description: `Save the release manager's memory on origin, where the next pass and any host that takes over read it. memory replaces the whole notes file (at most ${MEMORY_MAX} characters); event appends one line to the ledger.`,
    promptSnippet: "Save the release manager's notes or log an event",
    defaultActive: false,
    parameters: Type.Object({
      memory: Type.Optional(Type.String({ description: 'The complete new notes, in markdown' })),
      event: Type.Optional(Type.String({ description: 'One line for the event ledger' })),
    }),
    async execute(_id: string, params: { memory?: string; event?: string }) {
      if (params.memory === undefined && !params.event) throw new Error('Give memory or event.')
      if ((params.memory?.length ?? 0) > MEMORY_MAX)
        throw new Error(`Memory is limited to ${MEMORY_MAX} characters. Summarize it.`)
      const epoch = heldEpoch(runtime)
      const result = await runtime.exclusive(() =>
        recordState(runtime.git, runtime.local(), runtime.claimant(), epoch, runtime.now(), params),
      )
      if (result !== 'ok') {
        runtime.lost()
        throw new Error('Not saved: this lane no longer holds the release lease.')
      }
      return text('Saved.')
    },
  })
}

interface Question {
  question: string
  options: string[]
  default: string
  wait_minutes?: number
}

/** Deliberately not awaited by the tool: the pass goes on, and the answer starts a later run. */
function deliverAnswer(
  pi: ToolsApi,
  params: Question,
  minutes: number,
  answer: Promise<string | undefined>,
) {
  answer
    .then((choice) =>
      pi.sendMessage?.(
        {
          customType: ANSWER_MESSAGE,
          content:
            choice === undefined
              ? `No answer to "${params.question}" within ${minutes} minutes. Going with the default: ${params.default}.`
              : `The user answered "${params.question}": ${choice}.`,
          display: true,
        },
        { triggerTurn: true, deliverAs: 'followUp' },
      ),
    )
    .catch(() => undefined)
}

function registerAsk(pi: ToolsApi): void {
  pi.registerTool({
    name: 'release_ask',
    label: 'Ask the user',
    description:
      'Ask the user for a decision without stopping the pass. The question waits in this lane and alerts the user; the answer, or the default once the wait runs out, arrives later as a message. Continue with other work and end the pass.',
    promptSnippet: 'Ask the user for a release decision, with a default',
    defaultActive: false,
    parameters: Type.Object({
      question: Type.String({ description: 'One self-contained question, naming the PR' }),
      options: Type.Array(Type.String(), { minItems: 2, maxItems: 6 }),
      default: Type.String({ description: 'The option taken if nobody answers' }),
      wait_minutes: Type.Optional(Type.Integer({ minimum: 5, maximum: 1440 })),
    }),
    async execute(_id: string, params: Question, _signal: unknown, _update: unknown, ctx: ToolUi) {
      if (!params.options.includes(params.default))
        throw new Error('default must be one of the options.')
      const minutes = params.wait_minutes ?? 240
      const answer = ctx.ui.select(params.question, params.options, { timeout: minutes * 60_000 })
      deliverAnswer(pi, params, minutes, answer)
      return text(
        `Asked. The answer arrives as a message; after ${minutes} minutes the default (${params.default}) applies.`,
      )
    },
  })
}

function registerFlag(pi: ToolsApi, runtime: ReleaseRuntime): void {
  pi.registerTool({
    name: 'release_flag',
    label: 'Flag this pass',
    description:
      'Alert the user when this pass ends: for a revert, a takeover, a failed release, or anything else they should hear about. End the pass with the summary they should read first.',
    promptSnippet: 'Alert the user when this release pass ends',
    defaultActive: false,
    parameters: Type.Object({}),
    async execute() {
      runtime.flag()
      return text('Flagged: the user is alerted when this pass ends. Lead your summary with it.')
    },
  })
}

export function registerReleaseTools(pi: ToolsApi, runtime: ReleaseRuntime): void {
  registerMerge(pi, runtime)
  registerMemory(pi, runtime)
  registerAsk(pi)
  registerFlag(pi, runtime)
}
