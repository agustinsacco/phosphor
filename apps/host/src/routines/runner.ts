import { realpathSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { gitInfo } from '@phosphor/session-runtime/git/git-info'
import { git } from '@phosphor/session-runtime/git/git-exec'
import { listPackages } from '@phosphor/session-runtime/pi/packages'
import { assertClaudeContextProvider } from '@phosphor/session-runtime/pi/provider-detect'
import { outcomeForMessages, type RunOutcome } from '@phosphor/session-runtime/routines/outcome'
import type { RoutineExecutor } from '@phosphor/session-runtime/routines/scheduler'
import {
  ownRoutineSession,
  releaseRoutineSession,
} from '@phosphor/session-runtime/routines/ownership'
import { routinePrompt } from '@phosphor/shared/routines'
import type { AgentMessage, RpcCommand } from '@phosphor/shared/rpc'
import type { HostRuntime } from '../session/runtime'
import { prepareLaneFolder } from '../lanes/worktree'

/** Never types into a terminal. A new admitted pi session owns each execution. */
export function createRoutineExecutor(
  runtime: HostRuntime,
  admittedRoot: (path: string) => string,
): RoutineExecutor {
  return async (run, signal, progress) => {
    let sessionId: string | undefined
    let dispatched = false
    let settled = false
    let resolve: (outcome: RunOutcome) => void = () => {}
    const completed = new Promise<RunOutcome>((done) => {
      resolve = done
    })
    const finish = (outcome: RunOutcome) => {
      if (!settled) {
        settled = true
        resolve(outcome)
      }
    }
    let toolErrors = false
    let assistant: AgentMessage | undefined
    const abort = () =>
      finish({
        status: 'cancelled',
        reason: 'Stopped. External effects may already have completed.',
      })
    signal.addEventListener('abort', abort, { once: true })
    try {
      signal.throwIfAborted()
      const definition = run.definition
      const root = admittedRoot(definition.workspacePath)
      let cwd = root
      if (definition.isolated) {
        const folder = await prepareLaneFolder({
          root,
          worktree: { branch: `phosphor/routine/${randomUUID()}` },
        })
        if (!folder.branch) throw new Error('isolation')
        cwd = realpathSync.native(folder.cwd)
        progress({
          workspacePath: cwd,
          branch: folder.branch,
          baseCommit: (await git(cwd, ['rev-parse', 'HEAD'])).trim(),
        })
      } else {
        if (runtime.list().some((session) => realpathSync.native(session.workspacePath) === root))
          throw new Error('occupied')
        const info = await gitInfo(root)
        if (definition.intent === 'code' && info.isRepo && info.dirtyCount) throw new Error('dirty')
        progress({ workspacePath: cwd })
      }
      signal.throwIfAborted()
      const live = await runtime.startRoutine(
        { repository: cwd, provider: definition.provider, model: definition.model },
        (push) => {
          if (push.kind === 'exit')
            finish({
              status: 'interrupted',
              reason: 'Agent exited. Inspect partial effects before retrying.',
            })
          if (
            push.kind === 'extension-ui' &&
            ['input', 'select', 'confirm', 'editor'].includes(push.request.method)
          )
            finish({
              status: 'blocked',
              reason: 'Input or authentication required. No dialog was answered.',
            })
          if (push.kind !== 'event') return
          const event = push.event
          // A nested call's failure (a codemode script's) is the script's to handle.
          if (event.type === 'tool_execution_end' && event.isError && !event.parentToolCallId)
            toolErrors = true
          if (event.type === 'message_end' && event.message.role === 'assistant')
            assistant = event.message
          if (event.type === 'extension_error')
            finish({ status: 'failed', reason: 'An extension failed.' })
          if (event.type === 'agent_end' && !event.willRetry)
            finish(
              outcomeForMessages(
                event.messages.length ? event.messages : assistant ? [assistant] : [],
                toolErrors,
              ),
            )
        },
        { intent: definition.intent, signal },
      )
      sessionId = live.sessionId
      ownRoutineSession(sessionId)
      progress({ sessionId })
      const client = runtime.routineClient(sessionId)
      const request = async <T extends RpcCommand['type']>(
        command: Extract<RpcCommand, { type: T }>,
      ) => {
        signal.throwIfAborted()
        const response = await Promise.race([
          client.request(command),
          completed.then(() => {
            throw new Error('stopped')
          }),
        ])
        if (!response.success) throw new Error('pi rejected request')
        return response
      }
      const state = await request({ type: 'get_state' })
      if (
        !state.success ||
        !state.data ||
        state.data.model?.provider !== definition.provider ||
        state.data.model.id !== definition.model
      )
        throw new Error('model mismatch')
      if (state.data.model.provider === 'pi-claude-cli')
        assertClaudeContextProvider(await listPackages(cwd))
      if (state.data.sessionFile) {
        progress({ sessionPath: state.data.sessionFile })
        ownRoutineSession(sessionId, state.data.sessionFile)
      }
      await request({ type: 'set_auto_retry', enabled: false })
      signal.throwIfAborted()
      if (settled) return await completed
      dispatched = true
      void client.request({ type: 'prompt', message: routinePrompt(run) }).then(
        (response) => {
          if (!response.success) finish({ status: 'failed', reason: 'Prompt was rejected.' })
        },
        () => finish({ status: 'interrupted', reason: 'Delivery uncertain. Nothing was retried.' }),
      )
      const outcome = await completed
      if (client.alive && !signal.aborted) {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const final = await Promise.race([
            client.request({ type: 'get_state' }),
            new Promise<null>((done) => {
              timer = setTimeout(() => done(null), 1500)
            }),
          ])
          if (final?.success && final.data?.sessionFile)
            progress({ sessionPath: final.data.sessionFile })
        } finally {
          clearTimeout(timer)
        }
      }
      return outcome
    } catch {
      return {
        status: signal.aborted ? 'cancelled' : dispatched ? 'failed' : 'blocked',
        reason: 'Run could not complete. Inspect its transcript and configuration before retrying.',
      }
    } finally {
      signal.removeEventListener('abort', abort)
      if (sessionId) {
        try {
          await runtime.stopRoutine(sessionId)
        } finally {
          releaseRoutineSession(sessionId)
        }
      }
    }
  }
}
