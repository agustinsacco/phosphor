// Minimal omp stand-in for rpc-client tests: omp's startup `ready` frame, then
// omp-shaped answers (get_available_commands, queuedMessageCount, branch).
// Unknown commands fail the way omp's do, so a missing translation shows up.
//
// Protocol v2 as `omp://rpc.md` specifies it: `negotiate_protocol` is answered
// after a delay (so a client that does not wait is caught writing early), and
// after it an oversized answer goes out as `rpc_chunk` frames. On v1 the same
// answer fails the way omp's does. Env knobs:
//   FAKE_OMP_NO_V2=1        ready frame offers only v1
//   FAKE_OMP_REFUSE_V2=1    negotiate_protocol fails
//   FAKE_OMP_CHUNK_FAULT    interleave | skip | length: break the chunk run
//   FAKE_OMP_REPLAY=<file>  recorded stdout (`omp-task-replay.json`): the n-th
//                           `prompt` writes `turns[n]`; `get_messages` answers
//                           with the messages those turns ended
//
// Subagents as `modes/rpc/rpc-subagents.ts` keeps them: forwarding starts at
// level `off`; `set_subagent_subscription` changes it; a subagent is in the
// `get_subagents` registry from its `started` lifecycle frame to its terminal
// one, and progress only updates one that is there.
const readline = require('node:readline')
const { readFileSync } = require('node:fs')

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
const MAX_FRAME = 1024 * 1024
const CHUNK = 256 * 1024
let negotiated = false
let answeredNegotiation = false
const early = []
const received = []
const replay = process.env.FAKE_OMP_REPLAY
  ? JSON.parse(readFileSync(process.env.FAKE_OMP_REPLAY, 'utf8'))
  : null
let replayedTurns = 0
const history = []
let subagentLevel = 'off'
const subagents = new Map()

/** One recorded frame, through the registry and its subscription gate. */
function emitRecorded(frame) {
  if (frame.type === 'message_end') history.push(frame.message)
  if (frame.type === 'subagent_lifecycle') {
    const payload = frame.payload
    const existing = subagents.get(payload.id)
    if (!existing && payload.status !== 'started') return
    if (payload.status === 'started') {
      subagents.set(payload.id, {
        id: payload.id,
        index: payload.index,
        agent: payload.agent,
        agentSource: payload.agentSource,
        description: payload.description ?? existing?.description,
        status: 'running',
        sessionFile: payload.sessionFile ?? existing?.sessionFile,
        parentToolCallId: payload.parentToolCallId,
        lastUpdate: 1,
        progress: existing?.progress,
      })
    } else {
      subagents.delete(payload.id)
    }
    if (subagentLevel !== 'off') out(frame)
    return
  }
  if (frame.type === 'subagent_progress') {
    const { progress } = frame.payload
    const existing = subagents.get(progress.id)
    if (!existing) return
    subagents.set(progress.id, {
      ...existing,
      status: progress.status,
      lastUpdate: existing.lastUpdate + 1,
      progress,
    })
    if (subagentLevel !== 'off') out(frame)
    return
  }
  if (frame.type === 'subagent_event') {
    if (subagentLevel === 'events') out(frame)
    return
  }
  out(frame)
}

out({
  type: 'ready',
  protocolVersion: 1,
  supportedProtocolVersions: process.env.FAKE_OMP_NO_V2 ? [1] : [1, 2],
  maxFrameBytes: MAX_FRAME,
  maxReassembledFrameBytes: 64 * 1024 * 1024,
})
out({ type: 'available_commands_update', commands: [] })

function chunked(frame) {
  const bytes = Buffer.from(JSON.stringify(frame), 'utf8')
  const count = Math.ceil(bytes.length / CHUNK)
  const fault = process.env.FAKE_OMP_CHUNK_FAULT
  for (let index = 0; index < count; index++) {
    if (fault === 'skip' && index === 1) continue
    out({
      type: 'rpc_chunk',
      chunkId: 'rpc-1',
      index,
      count,
      byteLength: fault === 'length' ? bytes.length + 1 : bytes.length,
      data: bytes.subarray(index * CHUNK, (index + 1) * CHUNK).toString('base64'),
    })
    if (fault === 'interleave' && index === 0) out({ type: 'agent_start' })
  }
}

function send(frame) {
  const size = Buffer.byteLength(JSON.stringify(frame), 'utf8') + 1
  if (size <= MAX_FRAME) return out(frame)
  if (negotiated) return chunked(frame)
  out({
    id: frame.id,
    type: 'response',
    command: frame.command,
    success: false,
    error: 'RPC response exceeded the transport limit',
  })
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const cmd = JSON.parse(line)
  received.push(cmd.type)
  if (cmd.type !== 'negotiate_protocol' && !answeredNegotiation && !process.env.FAKE_OMP_NO_V2) {
    early.push(cmd.type)
  }
  const ok = (data) =>
    send({ id: cmd.id, type: 'response', command: cmd.type, success: true, data })
  switch (cmd.type) {
    case 'negotiate_protocol':
      return setTimeout(() => {
        answeredNegotiation = true
        if (process.env.FAKE_OMP_REFUSE_V2) {
          out({ id: cmd.id, type: 'response', command: cmd.type, success: false, error: 'no' })
          return
        }
        negotiated = cmd.protocolVersion === 2
        out({ id: cmd.id, type: 'response', command: cmd.type, success: true })
      }, 150)
    case 'get_available_commands':
      return ok({
        commands: [
          { name: 'compact', aliases: ['c'], description: 'Compact', source: 'builtin' },
          { name: 'skill:save', description: 'Save', source: 'skill' },
        ],
      })
    case 'get_state':
      return ok({
        sessionId: 'omp-session',
        sessionFile: '/fake/omp.jsonl',
        queuedMessageCount: 1,
        received,
        sentBeforeNegotiation: early,
      })
    case 'get_messages':
      if (replay) return ok({ messages: history })
      // One message well past the 1 MiB line cap, with multi-byte text so a
      // chunk boundary can land mid-character.
      return ok({
        messages: [{ role: 'user', content: 'é'.repeat(900 * 1024), timestamp: 1 }],
      })
    case 'set_subagent_subscription':
      if (!['off', 'progress', 'events'].includes(cmd.level)) {
        return out({
          id: cmd.id,
          type: 'response',
          command: cmd.type,
          success: false,
          error: `Invalid subagent subscription level: ${String(cmd.level)}`,
        })
      }
      subagentLevel = cmd.level
      return ok({ level: subagentLevel })
    case 'get_subagents':
      return ok({
        subagents: [...subagents.values()].sort(
          (a, b) => a.index - b.index || a.id.localeCompare(b.id),
        ),
      })
    case 'prompt': {
      const turn = replay?.turns[replayedTurns]
      if (!turn) break
      replayedTurns++
      ok(undefined)
      for (const frame of turn) emitRecorded(frame)
      return
    }
    case 'branch':
      out({ type: 'session_settled' })
      return ok({ text: 'rewound', cancelled: false })
    default:
      break
  }
  out({
    id: cmd.id,
    type: 'response',
    command: cmd.type,
    success: false,
    error: `Unknown command: ${cmd.type}`,
  })
})
