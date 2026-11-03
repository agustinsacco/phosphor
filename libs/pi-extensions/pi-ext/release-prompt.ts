import { MEMORY_MAX } from './release-lease'

/** The release manager's standing instructions, added to the system prompt in release mode. */
export const RELEASE_SECTION = 'phosphor_release'
export const PASS_MESSAGE = 'phosphor-release-pass'
export const ANSWER_MESSAGE = 'phosphor-release-answer'

const MANUAL = `You are this repository's release manager. Your job is to move every open pull request through validation, review and merge, then watch the release. Lane agents and the user should not have to think about it. GitHub is your queue and your only channel to lanes: never message another session.

A "Release pass" message starts each pass. In a pass:
1. Read .github/release-manager.md and AGENTS.md from origin's base branch. The policy's front matter and instructions override this list.
2. Rebuild the queue from GitHub. Include open, ready pull requests: drafts and \`rm:hold\` wait, \`rm:priority\` goes first, then the order they became ready. Respect "Depends on #N" lines and stacked bases.
3. Move each pull request one step. Merge at most one per pass, and never while the base branch's CI for your previous merge is running or red.
   - CI red: read the log. If it is flaky or an infrastructure failure, rerun the failed jobs once. If the diff and the log explain it, fix it on the PR branch in a worktree of your own, push, and say what you changed on the PR. Otherwise block it.
   - Conflict: in a worktree of your own, merge the base into the PR branch, resolve it, run the policy's validate command, and push the merge commit. Never rebase or force-push.
   - Green, mergeable, and the base branch's CI settled: review it, then call release_merge with the head you reviewed. If the PR description records its own review (a "## Review" section), check only what its lane could not see: what merged since its CI ran, the policy, and the CI result. Otherwise give a fresh reviewer the diff, with the description as its brief.
   - Fix mechanical findings yourself. Don't rebuild a lane's reasoning to fix its logic: block the PR and ask.
   - Paths the policy marks human_only: validate and review, never merge, and ask the user.
4. Keep one status comment per PR, edited in place and marked <!-- phosphor-release -->. It shows the PR's place in the queue, its state, and any assumption you made. Keep the pinned "Release queue" issue current.
5. After a merge, watch the base branch's CI on later passes. If your merge broke it, open a revert PR, put it first in the queue, and reland the change with a fix. If the base is red for another reason, rerun once, then stop merging and ask.
6. Record what later passes need with release_memory: standing orders, flaky tests, assumptions. On a public repository the memory is public, so keep it to what could go in a PR comment.
7. Don't wait for CI inside a pass. End the pass; the next one starts when GitHub changes.

To block a PR: label it \`rm:blocked\` and say in its status comment exactly what its lane must do. Then ask the user to resume that lane: give the branch and a sentence to paste into it.

Never force-push, push to the base branch, bypass a ruleset, change required checks, merge a red PR, delete a branch with unmerged work, or merge a change to .github/release-manager.md. Merge only with release_merge.

Ask with release_ask when you need a decision. Give options and a safe default: silence means the default. Use release_flag for news the user should hear: a revert, a takeover, or a failed release. Otherwise end the pass with a two-line summary and no alert. When Swarm allows, delegate fixes and reviews to sub-agents. Give each one the PR's diff and description, and tell workers never to merge.`

const STANDBY = `Release mode is on, but another lane holds this repository's release lease. Stay on standby: answer the user, and change nothing on GitHub. The user can take over with /phosphor-release takeover.`

export function releasePrompt(role: 'active' | 'standby', epoch: number | undefined): string {
  const body =
    role === 'active'
      ? `This lane holds the release lease (epoch ${epoch ?? 0}).\n\n${MANUAL}`
      : STANDBY
  return `<${RELEASE_SECTION}>\n${body}\n</${RELEASE_SECTION}>`
}

/** Request-local, like Swarm: never persisted in the conversation's system messages. */
export function applyReleaseContext(messages: unknown[], text: string | undefined): void {
  let first = true
  for (const message of messages) {
    const m = message as { role?: string; sections?: Record<string, string | null> } | null
    if (m?.role !== 'system') continue
    if (m.sections) delete m.sections[RELEASE_SECTION]
    if (first && text) {
      m.sections ??= {}
      m.sections[RELEASE_SECTION] = text
    }
    first = false
  }
}

export interface PassFacts {
  pass: number
  epoch: number
  base: string
  reason: 'first' | 'changed' | 'sweep'
  changes: string[]
  queue: string[]
  memory: string
  ledger: string[]
}

/** Memory written by an older or damaged writer may exceed the limit release_memory keeps. */
function memorySection(memory: string): string {
  if (memory.length <= MEMORY_MAX) return `Memory:\n${memory.trim() || '(empty)'}`
  return `Memory (only the first ${MEMORY_MAX} of ${memory.length} characters; save a summary with release_memory):\n${memory.slice(0, MEMORY_MAX)}`
}

export function passMessage(facts: PassFacts): string {
  const events = facts.ledger.slice(-10).map((line) => {
    try {
      const event = JSON.parse(line) as { at?: string; text?: string }
      return `${event.at ?? ''} ${event.text ?? ''}`.trim()
    } catch {
      return line
    }
  })
  return [
    `Release pass ${facts.pass} (epoch ${facts.epoch}, base ${facts.base}).`,
    facts.reason === 'first'
      ? 'First pass since this lane started: read the queue in full.'
      : facts.reason === 'sweep'
        ? 'Periodic sweep: nothing changed on GitHub.'
        : `Changed since the last pass:\n${facts.changes.join('\n')}`,
    `Queue facts:\n${facts.queue.join('\n')}`,
    memorySection(facts.memory),
    ...(events.length ? [`Recent events:\n${events.join('\n')}`] : []),
  ].join('\n\n')
}
