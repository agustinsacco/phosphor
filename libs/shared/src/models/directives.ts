/**
 * Layer 2 of the directive stack: what Phosphor appends to a lane's system
 * prompt. See `apps/desktop/electron/pi/directives.ts` for the full stack and why this is
 * a setting rather than a constant.
 *
 * Global by default with a per-project override, because the right contents
 * depend on the repo AND on which model the lane runs: Anthropic's frontier
 * models now ship a system prompt roughly 70-80% shorter than the previous
 * generation, and a mixed fleet needs a lean profile and a fuller one.
 */
export interface AgentDirectivePrefs {
  /** Machine-local context, fixed at spawn and shared by all providers. */
  machineAwareness: boolean
  /**
   * The worktree working-directory block. On by default and worth keeping:
   * it is the reason a whole class of confident wrong-branch answers stopped
   * (session 01a02ca0 read a copy 19 commits behind main and recommended
   * building a feature that already existed in its own worktree).
   */
  worktreeGuard: boolean
  /** The lane charter: this is a lane, it owns a branch, it ends in a PR. */
  laneCharter: boolean
  /**
   * The sub-agent policy block.
   *
   * On by default because the default is the unsafe one. A Claude Code
   * sub-agent launches in the BACKGROUND unless the caller passes
   * `run_in_background: false`, and the CLI is a per-turn model server that
   * exits when the turn's answer is done — so a backgrounded agent is killed
   * mid-flight and its findings never reach the model that asked for them.
   * Observed 2026-08-27: one lane launched five, they spawned two more, and
   * all seven died at the same millisecond having spent 28.6M tokens on work
   * nobody ever read. A synchronous sub-agent completes inside the turn and
   * returns normally (verified against `claude -p`), so this block asks for
   * the form that works rather than banning the tool.
   */
  subagentPolicy: boolean
  /** Free text appended last, so it can qualify either block above. */
  custom: string
}

export const DEFAULT_AGENT_DIRECTIVES: AgentDirectivePrefs = {
  machineAwareness: true,
  worktreeGuard: true,
  laneCharter: true,
  subagentPolicy: true,
  custom: '',
}
