'use strict'
const { existsSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const tools = require('./tools.cjs')

function publishQueue(ctx) {
  ctx.ports.out({
    type: 'queue_update',
    steering: ctx.queued.filter((item) => item.mode === 'steer').map((item) => item.message),
    followUp: ctx.queued.filter((item) => item.mode !== 'steer').map((item) => item.message),
  })
}
function delta(ctx, value) {
  ctx.ports.out({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: value },
  })
}
function finish(ctx, _user, reply, stopReason, errorMessage) {
  const message = { ...ctx.ports.text(reply), stopReason, ...(errorMessage && { errorMessage }) }
  ctx.ports.out({ type: 'message_end', message })
  ctx.ports.persist(message)
  ctx.ports.out({ type: 'agent_end', messages: [message] })
  ctx.ports.out({ type: 'agent_settled', aborted: stopReason === 'aborted' })
  const next = ctx.queued.shift()
  publishQueue(ctx)
  if (next) setTimeout(() => prompt(ctx, next.message), 10)
}
function prompt(ctx, message, images = []) {
  ctx.ports.persist({ role: 'user', content: message })
  ctx.ports.out({ type: 'agent_start' })
  ctx.ports.out({ type: 'message_start', message: { role: 'user', content: message } })
  ctx.ports.out({ type: 'message_end', message: { role: 'user', content: message } })
  ctx.ports.out({ type: 'message_start', message: ctx.ports.text('') })
  if (/artifact/i.test(message)) tools.artifact(ctx.toolState, ctx.ports)
  if (/links/i.test(message)) tools.linkTool(ctx.ports)
  if (/receipt-test/.test(message)) tools.receiptTools(ctx.ports)
  if (/stream|count|slow/i.test(message) || ctx.env.FAKE_PI_STALL) {
    startStream(ctx, message)
    return
  }
  const tokens =
    /recall/i.test(message) && !ctx.env.FAKE_PI_FORGET
      ? ctx.session.messages.flatMap(
          (m) => JSON.stringify(m.content).match(/PHX-[A-Za-z0-9]+/g) ?? [],
        )
      : /PHX-[A-Za-z0-9]+/.exec(message)
  const reply = /PHX-hostinputs/.test(message)
    ? tools.attachmentReply(message, images)
    : /links/i.test(message)
      ? `[${tools.laneMarker(ctx.ports.cwd)} guide](nested/guide.md#L2) [absolute](${join(ctx.ports.cwd, 'remote.txt')}) [outside](/etc/passwd)`
      : (ctx.env.FAKE_PI_TURN !== 'wrong' && tokens?.at(-1)) || 'ok'
  delta(ctx, reply)
  if (ctx.env.FAKE_PI_TURN === 'fail' || /fail-turn|auth-error/.test(message)) {
    const error = /auth-error/.test(message)
      ? '401 unauthorized: login expired'
      : /fail-turn/.test(message)
        ? `${tools.laneMarker(ctx.ports.cwd)} provider error`
        : `401: invalid x-api-key ${ctx.env.ANTHROPIC_API_KEY}`
    return setTimeout(() => finish(ctx, message, '', 'error', error), 10)
  }
  if (ctx.env.FAKE_PI_TURN === 'exit') return setTimeout(() => process.exit(3), 50)
  setTimeout(() => finish(ctx, message, reply, 'stop'), 10)
}

function startStream(ctx, message) {
  if (ctx.env.FAKE_PI_STALL) writeFileSync(ctx.env.FAKE_PI_STALL, String(process.pid))
  const releaseFile = /^slow-until (.+)$/.exec(message)?.[1]
  // Safety bound only: callers release or cancel the turn. It must outlast a slow
  // runner's UI action, or the turn ends before the test can act on it.
  const deadline = Date.now() + 60000
  let count = 0
  ctx.streaming = { user: message, reply: '' }
  ctx.streaming.timer = setInterval(() => {
    const piece = `${++count} `
    ctx.streaming.reply += piece
    delta(ctx, piece)
    const released = releaseFile && existsSync(releaseFile)
    const expired = releaseFile && Date.now() >= deadline
    if (released || expired || (!releaseFile && /slow/i.test(message) && count === 12)) {
      const completed = ctx.streaming
      clearInterval(completed.timer)
      ctx.streaming = null
      finish(
        ctx,
        completed.user,
        completed.reply,
        expired ? 'error' : 'stop',
        expired ? 'Fixture slow turn was not released within 10 seconds' : undefined,
      )
    }
  }, 20)
}

function createTurns(session, ports, env = process.env) {
  const ctx = {
    session,
    ports,
    env,
    toolState: tools.createToolState(session.messages),
    streaming: null,
    queued: [],
  }
  return {
    state: ctx,
    prompt: (message, images) => prompt(ctx, message, images),
    enqueue: (message, mode) => {
      ctx.queued.push({ message, mode })
      publishQueue(ctx)
    },
    abort: () => {
      if (!ctx.streaming) return
      const { user, reply, timer } = ctx.streaming
      clearInterval(timer)
      ctx.streaming = null
      return finish(ctx, user, reply, 'aborted')
    },
  }
}

module.exports = { createTurns }
