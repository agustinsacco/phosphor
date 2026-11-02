'use strict'
const { randomUUID } = require('node:crypto')
const { existsSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const persistence = require('./persistence.cjs')
const { laneMarker } = require('./tools.cjs')

/** Run `then` once `file` exists, after writing `file`.held to say it waits. */
function holdUntil(file, then) {
  writeFileSync(`${file}.held`, '')
  const timer = setInterval(() => {
    if (!existsSync(file)) return
    clearInterval(timer)
    then()
  }, 10)
}

function state(ctx) {
  return {
    ...ctx.initialState(),
    ...(ctx.selectedModel && { model: ctx.selectedModel }),
    ...(ctx.selectedThinking != null && { thinkingLevel: ctx.selectedThinking }),
  }
}

function getState(ctx, cmd) {
  const answer = () => {
    if (ctx.lostState === 'fails') return ctx.fail(cmd, 'cannot read the session')
    return ctx.respond(cmd, {
      ...state(ctx),
      ...(ctx.lostState === 'hides' && { sessionFile: undefined }),
    })
  }
  if (ctx.heldState === null) return answer()
  const release = ctx.heldState
  ctx.heldState = null
  return holdUntil(release, answer)
}

function ask(ctx, cmd) {
  const dialog = randomUUID()
  ctx.dialogs.set(dialog, (answer) => {
    console.error(`FAKE_PI_DIALOG ${JSON.stringify(answer)}`)
    ctx.respond(cmd)
  })
  return ctx.out({
    type: 'extension_ui_request',
    id: dialog,
    method: 'confirm',
    title: 'Allow?',
    message: 'The fake asks',
  })
}

const extensionPrompts = {
  '/fake-clone': (ctx, cmd) => {
    persistence.clone(ctx.session)
    return ctx.respond(cmd)
  },
  '/fake-clone-fails': (ctx, cmd) => {
    persistence.clone(ctx.session)
    return ctx.fail(cmd, 'the extension failed')
  },
  '/fake-clone-hold-reply': (ctx, cmd, arg) => {
    persistence.clone(ctx.session)
    return holdUntil(arg, () => ctx.respond(cmd))
  },
  '/fake-clone-hold-state': (ctx, cmd, arg) => {
    persistence.clone(ctx.session)
    ctx.heldState = arg
    return ctx.respond(cmd)
  },
  '/fake-clone-lose-state': (ctx, cmd) => moveAndLose(ctx, cmd, 'fails'),
  '/fake-clone-hide-file': (ctx, cmd) => moveAndLose(ctx, cmd, 'hides'),
  '/fake-find-file': (ctx, cmd) => {
    ctx.lostState = null
    return ctx.respond(cmd)
  },
  '/fake-ask': ask,
}

function moveAndLose(ctx, cmd, lostState) {
  persistence.clone(ctx.session)
  ctx.lostState = lostState
  return ctx.respond(cmd)
}

function prompt(ctx, cmd) {
  const space = cmd.message.indexOf(' ')
  const name = space === -1 ? cmd.message : cmd.message.slice(0, space)
  if (Object.hasOwn(extensionPrompts, name))
    return extensionPrompts[name](ctx, cmd, cmd.message.slice(space + 1))
  ctx.respond(cmd)
  if (cmd.message === '/host-only') {
    ctx.out({
      type: 'extension_ui_request',
      id: randomUUID(),
      method: 'notify',
      message: 'HOST_A_ONLY command handled',
      notifyType: 'info',
    })
    return
  }
  if (cmd.message.startsWith('/phosphor-context-budget ')) return
  if (ctx.turns.state.streaming) {
    ctx.turns.enqueue(cmd.message, cmd.streamingBehavior ?? 'followUp')
    return
  }
  ctx.turns.prompt(cmd.message, cmd.images ?? [])
}

function getCommands(ctx, cmd) {
  ctx.respond(cmd, {
    commands: [
      ...(ctx.breakdown && ctx.env.FAKE_PI_HIDE !== 'budget'
        ? [
            { name: 'phosphor-context-budget', source: 'extension' },
            { name: 'host-only', description: 'HOST_A_ONLY command', source: 'extension' },
          ]
        : []),
      ...(existsSync(join(ctx.agentDir, 'skills', 'host-only', 'SKILL.md'))
        ? [
            {
              name: 'skill:host-only',
              description: 'HOST_A_ONLY fixture',
              source: 'skill',
              sourceInfo: {
                path: join(ctx.agentDir, 'skills', 'host-only', 'SKILL.md'),
                scope: 'user',
              },
            },
          ]
        : []),
    ],
  })
}

function setModel(ctx, cmd) {
  ctx.selectedModel = ctx.models.find(
    (model) => model.provider === cmd.provider && model.id === cmd.modelId,
  ) ?? { provider: cmd.provider, id: cmd.modelId, contextWindow: 200000 }
  persistence.setModel(ctx.session, ctx.selectedModel)
  return ctx.respond(cmd, ctx.selectedModel)
}

function compact(ctx, cmd) {
  ctx.out({ type: 'compaction_start', reason: 'manual' })
  ctx.respond(cmd, { summary: 'HOST_A_ONLY compacted', firstKeptEntryId: '', tokensBefore: 0 })
  return ctx.out({
    type: 'compaction_end',
    reason: 'manual',
    aborted: false,
    result: { summary: 'HOST_A_ONLY compacted', firstKeptEntryId: '', tokensBefore: 0 },
  })
}

function getSessionStats(ctx, cmd) {
  const { session } = ctx
  return ctx.respond(cmd, {
    sessionId: session.id,
    sessionFile: session.sessionFile,
    userMessages: session.messages.filter((m) => m.role === 'user').length,
    assistantMessages: session.messages.filter((m) => m.role === 'assistant').length,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: session.messages.length,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  })
}

const handlers = {
  get_state: getState,
  prompt,
  steer: (ctx, cmd) => enqueue(ctx, cmd, 'steer'),
  follow_up: (ctx, cmd) => enqueue(ctx, cmd, 'followUp'),
  abort: (ctx, cmd) => {
    ctx.respond(cmd)
    return ctx.turns.abort()
  },
  extension_ui_response: (ctx, cmd) => {
    const answered = ctx.dialogs.get(cmd.id)
    ctx.dialogs.delete(cmd.id)
    const { type: _, id: __, ...answer } = cmd
    return answered?.(answer)
  },
  get_commands: getCommands,
  set_model: setModel,
  set_thinking_level: (ctx, cmd) => {
    ctx.selectedThinking = cmd.level
    return ctx.respond(cmd)
  },
  set_session_name: (ctx, cmd) => {
    persistence.setName(ctx.session, cmd.name)
    return ctx.respond(cmd)
  },
  compact,
  get_available_thinking_levels: (ctx, cmd) =>
    ctx.respond(cmd, {
      levels: state(ctx).model.reasoning ? ['off', 'low', 'medium', 'high'] : ['off'],
    }),
  get_available_models: (ctx, cmd) => ctx.respond(cmd, { models: ctx.models }),
  get_session_stats: getSessionStats,
  get_messages: (ctx, cmd) => ctx.respond(cmd, { messages: ctx.session.messages }),
  get_last_assistant_text: (ctx, cmd) => {
    const last = ctx.session.messages.findLast((m) => m.role === 'assistant')
    return ctx.respond(cmd, {
      text: last ? last.content.map((block) => block.text).join('') : null,
    })
  },
  set_auto_retry: (ctx, cmd) => ctx.respond(cmd, { enabled: cmd.enabled }),
  // pi's RPC `bash` (a composer `!command`) runs in pi's cwd: the answer names the
  // checkout it ran in, so a test can tell the Host's shell from This Mac's.
  bash: (ctx, cmd) =>
    ctx.respond(cmd, {
      output: `${laneMarker(process.cwd())} shell: ${cmd.command}\n`,
      exitCode: 0,
      cancelled: false,
      truncated: false,
    }),
}

function enqueue(ctx, cmd, mode) {
  ctx.turns.enqueue(cmd.message, mode)
  return ctx.respond(cmd)
}

function createDispatcher(ports, env = process.env) {
  const ctx = {
    ...ports,
    env,
    heldState: null,
    lostState: null,
    dialogs: new Map(),
    selectedModel: undefined,
    selectedThinking: undefined,
  }
  return (cmd) => {
    if (cmd.type === env.PI_FAKE_SILENT) return
    if (!Object.hasOwn(handlers, cmd.type)) return ctx.fail(cmd, 'unsupported in fake')
    return handlers[cmd.type](ctx, cmd)
  }
}

module.exports = { createDispatcher }
