import { stat } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { spawnSession } from '../pi/session-runtime'
import { registry } from '../registry'
import { createLaneWorkspace } from '../fs/lane-workspace'
import { git } from '../fs/git-exec'
import { gitInfo } from '../fs/git-info'
import { bindSession } from '../claude/accounts'
import { spawnAccountFor, forgetSpawnAccount } from '../pi/session-accounts'
import { assertClaudeContextProvider } from '../pi/provider-detect'
import { listPackages } from '../pi/packages'
import { piStubPath } from '../pi/stub'
import { broadcast } from '../broadcast'
import { routinePrompt, type RoutineRun } from '@shared/routines'
import type { AgentMessage, RpcCommand, RpcResponse } from '@shared/rpc'
import { ownRoutineSession, releaseRoutineSession, routineSessionObserved } from './ownership'
import { outcomeForMessages, type RunOutcome } from './outcome'

export type RunProgress = (patch: Partial<RoutineRun>) => void

/** No renderer, model-generated scheduling, or one-shot print-mode process. */
export async function executeRoutine(
  run: RoutineRun,
  signal: AbortSignal,
  progress: RunProgress,
): Promise<RunOutcome> {
  let sessionId: string | undefined
  let dispatched = false
  let finished = false
  let abandon: (() => void) | undefined
  try {
    const r = run.definition
    if (!(await stat(r.workspacePath)).isDirectory())
      throw new Error('Workspace is not a directory.')
    signal.throwIfAborted()
    let workspacePath = realpathSync.native(r.workspacePath)
    if (r.isolated) {
      const lane = await createLaneWorkspace({
        workspacePath,
        title: `${r.name}-${run.id.slice(0, 8)}`,
        branchPrefix: 'phosphor/routine/',
      })
      if (lane.warning || !lane.branch)
        throw new Error(`Isolation required: ${lane.warning ?? 'no branch created'}`)
      workspacePath = realpathSync.native(lane.workspacePath)
      progress({
        workspacePath,
        branch: lane.branch,
        baseCommit: (await git(workspacePath, ['rev-parse', 'HEAD'])).trim(),
      })
    } else {
      // Do not let an unattended agent mutate a folder an interactive lane owns.
      if (registry.list().some((s) => realpathSync.native(s.workspacePath) === workspacePath))
        throw new Error(
          'Workspace is in use by a live session. Suspend it or enable isolated worktrees.',
        )
      const info = await gitInfo(workspacePath)
      if (info.isRepo && info.dirtyCount)
        throw new Error('Workspace has uncommitted changes. Use an isolated worktree.')
      progress({ workspacePath })
    }
    signal.throwIfAborted()
    const live = await spawnSession(
      {
        workspacePath,
        name: `${r.name} · ${new Date(run.scheduledAt).toISOString().slice(0, 16)}`,
        provider: r.provider,
        model: r.model,
      },
      undefined,
      { unattended: true, intent: r.intent, signal },
    )
    sessionId = live.sessionId
    ownRoutineSession(sessionId)
    const session = registry.get(sessionId)!
    progress({ sessionId, accountId: spawnAccountFor(sessionId) ?? null })

    // Attach before the first request. A prompt response is an acknowledgement,
    // not the result. Crashes and unexpected dialogs also settle this waiter.
    let settle!: (outcome: RunOutcome) => void
    const completed = new Promise<RunOutcome>((resolve) => {
      settle = resolve
    })
    let toolErrors = false
    let lastAssistant: AgentMessage | undefined
    let settled = false
    const finish = (outcome: RunOutcome): void => {
      if (!settled) {
        settled = true
        settle(outcome)
      }
    }
    const abort = (): void => {
      finish({
        status: 'cancelled',
        reason: 'Execution stopped; external actions may already have completed.',
      })
      void session.client.request({ type: 'abort' }).catch(() => undefined)
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    abandon = () => signal.removeEventListener('abort', abort)
    session.client.on('event', (event) => {
      if (event.type === 'tool_execution_end' && event.isError) toolErrors = true
      if (event.type === 'message_end' && event.message.role === 'assistant')
        lastAssistant = event.message
      if (event.type === 'agent_end' && !event.willRetry)
        finish(
          outcomeForMessages(
            event.messages.length ? event.messages : lastAssistant ? [lastAssistant] : [],
            toolErrors,
          ),
        )
      if (event.type === 'extension_error')
        finish({ status: 'failed', reason: `Extension error: ${event.error}` })
    })
    session.client.on('exit', () =>
      finish({
        status: 'interrupted',
        reason: 'Agent process exited before a result. Inspect its transcript before retrying.',
      }),
    )
    session.client.on('extension-ui', (request) => {
      if (['input', 'select', 'confirm', 'editor'].includes(request.method)) {
        finish({
          status: 'blocked',
          reason:
            'The agent requires input or authentication. No prompt was auto-answered. Open the lane to resolve it, then edit and save the routine.',
        })
      }
    })

    const request = async (command: RpcCommand): Promise<RpcResponse> => {
      signal.throwIfAborted()
      const result = await Promise.race([
        session.client.request(command),
        completed.then((outcome) => {
          throw new Error(outcome.reason)
        }),
      ])
      if (!result.success) throw new Error(result.error || `pi ${command.type} failed`)
      return result
    }
    const state = await Promise.race([
      session.client.request({ type: 'get_state' }),
      completed.then((outcome) => {
        throw new Error(outcome.reason)
      }),
    ]).then((response) => {
      signal.throwIfAborted()
      if (!response.success || !response.data) throw new Error('Cannot verify the active pi model.')
      return response.data
    })
    if (state.model?.provider !== r.provider || state.model.id !== r.model)
      throw new Error(
        'The requested model did not resolve exactly. Edit the routine; no model fallback was used.',
      )
    if (!piStubPath() && state.model.provider === 'pi-claude-cli')
      assertClaudeContextProvider(await listPackages(workspacePath))
    if (state.sessionFile) {
      progress({ sessionPath: state.sessionFile })
      ownRoutineSession(sessionId, state.sessionFile)
      const account = spawnAccountFor(sessionId)
      if (account) await bindSession(state.sessionFile, account)
    }
    // Conservative default: no whole-turn automatic retries for unattended writes.
    await request({ type: 'set_auto_retry', enabled: false })
    signal.throwIfAborted()
    if (settled) return await completed
    dispatched = true
    // Do not await prompt completion before waiting for the terminal event.
    void session.client.request({ type: 'prompt', message: routinePrompt(run) }).then(
      (response) => {
        if (!response.success)
          finish({ status: 'failed', reason: response.error ?? 'Prompt was rejected.' })
      },
      (error: unknown) => finish({ status: 'interrupted', reason: String(error) }),
    )
    const outcome = await completed
    // pi persists at turn end. Refresh identity after completion too.
    if (session.client.alive && !signal.aborted) {
      const final = await Promise.race([
        session.client.request({ type: 'get_state' }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
      ])
      if (final?.success && final.data?.sessionFile)
        progress({ sessionPath: final.data.sessionFile })
    }
    finished = outcome.status === 'finished'
    return outcome
  } catch (error) {
    return {
      status: signal.aborted ? 'cancelled' : dispatched ? 'failed' : 'blocked',
      reason: error instanceof Error ? error.message : String(error),
    }
  } finally {
    abandon?.()
    if (sessionId) {
      // An explicitly opened successful lane becomes an ordinary interactive
      // session for follow-up. Unobserved runs release their process immediately.
      const keepForReview = finished && !signal.aborted && routineSessionObserved(sessionId)
      if (!keepForReview) {
        await registry.dispose(sessionId)
        forgetSpawnAccount(sessionId)
      }
      releaseRoutineSession(sessionId)
    }
    broadcast('sessions:changed', {
      workspacePath: run.workspacePath ?? run.definition.workspacePath,
    })
  }
}
