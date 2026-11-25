'use strict'
/**
 * Two ways a lane is busy while the composer's chat reads idle, for the
 * steer/queue e2e.
 *
 * `post-run-hold`: pi ended the run (`agent_end`) but has not settled, so it
 * still refuses a plain prompt with its own words, as pi does mid-run. A
 * steer or follow-up is accepted and held.
 *
 * `delegated-hold`: the run settled, but a background agent still runs (the
 * pi-subagents widget). pi is idle, so a steer starts a run like a prompt and
 * echoes the user message, as pi does.
 */

/** pi's refusal of a plain prompt while it processes. */
const PI_BUSY =
  "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."

const delegatedWidget = (state) => ({
  type: 'extension_ui_request',
  id: `delegated-${state}`,
  method: 'setWidget',
  widgetKey: 'subagent-async',
  widgetLines: [
    'PI_SUBAGENT_ASYNC_JSON:' +
      JSON.stringify({
        kind: 'pi-subagents.async-status-snapshot',
        version: 1,
        runs: [{ id: 'run-busy', label: 'Reviewer', state, children: [] }],
      }),
  ],
})

let held = false
let delegated = false

/** Runs a scenario's prompt after pi accepted it; true when it was one. */
function runBusyScenario(message, out) {
  if (delegated) {
    delegated = false
    echoTurn(message, out)
    return true
  }
  if (message === 'post-run-hold') {
    out({ type: 'agent_start' })
    reply('Held after the run.', out)
    out({ type: 'agent_end', messages: [] })
    held = true
    return true
  }
  if (message === 'delegated-hold') {
    out({ type: 'agent_start' })
    out(delegatedWidget('running'))
    reply('Delegated to a reviewer.', out)
    out({ type: 'agent_end', messages: [] })
    out({ type: 'agent_settled', aborted: false })
    delegated = true
    return true
  }
  return false
}

/** Answers a prompt during `post-run-hold`, before the generic path; true when it did. */
function answerHeldPrompt(cmd, out) {
  if (!held) return false
  out(
    cmd.streamingBehavior
      ? {
          id: cmd.id,
          type: 'response',
          command: 'prompt',
          success: true,
          data: { disposition: 'queued' },
        }
      : { id: cmd.id, type: 'response', command: 'prompt', success: false, error: PI_BUSY },
  )
  return true
}

function reply(text, out) {
  const message = {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    timestamp: Date.now(),
  }
  out({ type: 'message_start', message })
  out({ type: 'message_end', message })
}

/** pi's events for a prompt that started a run: the user echo, a reply, the settle. */
function echoTurn(message, out) {
  const user = { role: 'user', content: [{ type: 'text', text: message }], timestamp: Date.now() }
  out({ type: 'agent_start' })
  out({ type: 'message_start', message: user })
  out({ type: 'message_end', message: user })
  reply(`Read: ${message}`, out)
  out(delegatedWidget('complete'))
  out({ type: 'agent_end', messages: [] })
  out({ type: 'agent_settled', aborted: false })
}

module.exports = { runBusyScenario, answerHeldPrompt }
