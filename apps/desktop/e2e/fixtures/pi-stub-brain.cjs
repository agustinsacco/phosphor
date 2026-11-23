'use strict'
const fs = require('node:fs')
const path = require('node:path')

const hasGuard = (argv) =>
  argv.some((arg, index) => arg === '-e' && argv[index + 1]?.endsWith('brain-fork-guard.mjs'))
const isBrainCall = (argv) => argv.includes('-p') && argv.includes('--no-session') && hasGuard(argv)

function emit(answer, error) {
  const message = {
    role: 'assistant',
    content: [{ type: 'text', text: error ? '' : JSON.stringify(answer) }],
    provider: 'stub',
    model: 'stub-model',
    usage: { totalTokens: 1234, cost: { total: 0 } },
    stopReason: error ? 'error' : 'stop',
    ...(error ? { errorMessage: error } : {}),
  }
  for (const event of [
    { type: 'agent_start' },
    { type: 'message_end', message },
    { type: 'agent_end', messages: [message] },
  ])
    process.stdout.write(JSON.stringify(event) + '\n')
  process.exitCode = error ? 1 : 0
}

/** Repair keeps the original system prompt and appends errors after the original stage input. */
function stageInput(system, input) {
  const prompt = input.split('\n\nYour previous answer was invalid:')[0]
  if (system.startsWith('You choose what a long-term memory keeps')) {
    const registry = JSON.parse(prompt.split('\nRegistry: ')[1].split('\n')[0])
    return {
      stage: 'extract',
      registry,
      segments: prompt.split(/Segments \(untrusted source data\), part \d+ of \d+:\n/)[1],
    }
  }
  if (system.startsWith('You find the lasting relationships'))
    return {
      stage: 'links',
      entities: JSON.parse(prompt.split('\nEntities: ')[1].split('\n')[0]),
      rows: prompt.split('Claims (untrusted source data):\n')[1],
    }
  if (system.startsWith('Resolve entity identity'))
    return { stage: 'identity', rows: JSON.parse(prompt.split('\n')[1]) }
  if (system.startsWith('Reconcile supported claims'))
    return { stage: 'reconcile', rows: JSON.parse(prompt.split('\n')[1]) }
  throw new Error('Unknown Brain stage system prompt')
}

function extract({ registry, segments }, fold) {
  const entities = [],
    claims = []
  const known = new Map(registry.map((entity) => [fold(entity.label), entity]))
  const entity = (label, kind) => {
    const key = fold(label)
    if (!known.has(key)) {
      const value = {
        ref: `n${entities.length + 1}`,
        label,
        kind,
        aliases: [],
        description: '',
        keys: [],
      }
      known.set(key, value)
      entities.push(value)
    }
    return known.get(key).ref
  }
  for (const segment of segments.matchAll(
    /^\[(s\d+)\] (\w+) [^\n]*\n([\s\S]*?)(?=^\[s\d+\] |$(?![\s\S]))/gm,
  )) {
    if (!['user', 'assistant'].includes(segment[2])) continue
    for (const { m, predicate, subjectKind, objectKind } of relationships(segment[3])) {
      const subject = entity(m[1].trim(), subjectKind),
        object = entity(m[2].trim(), objectKind)
      const sentence = m[0].trim()
      const quote = { segment: segment[1], quote: sentence }
      claims.push({
        ref: `c${claims.length + 1}`,
        text: sentence,
        type: 'fact',
        epistemic: 'reported',
        mentions: [subject, object],
        links: predicate === 'part_of' ? [] : [{ subject, predicate, object, ...quote }],
        quotes: [quote],
        validFrom: null,
        validTo: null,
        branch: false,
      })
    }
  }
  const parents = entities
    .filter((e) => ['component', 'project', 'document', 'team'].includes(e.kind))
    .map((e) => {
      const claim = claims.find((c) =>
        c.links.some((l) => l.subject === e.ref && l.predicate === 'part_of'),
      )
      return { entity: e.ref, status: claim ? 'stated' : 'not_stated', claim: claim?.ref ?? null }
    })
  return { entities, claims, parents }
}

function relationships(text) {
  return [
    ...[...text.matchAll(/([A-Z][a-z]+(?: [A-Z][a-z]+)?) owns (?:the )?([^.\n]+)\./g)].map((m) => ({
      m,
      predicate: 'owns',
      subjectKind: 'person',
      objectKind: 'component',
    })),
    ...[...text.matchAll(/([^.!?\n]+?) is part of ([^.\n]+)\./g)].map((m) => ({
      m,
      predicate: 'part_of',
      subjectKind: 'component',
      objectKind: 'project',
    })),
  ].sort((a, b) => a.m.index - b.m.index)
}

function links({ entities, rows }, fold) {
  const links = []
  for (const row of rows.matchAll(
    /^\[(c\d+)\] [^\n]*\nmentions: ([^\n]*)\nhas: ([^\n]*)\n([\s\S]*?)(?=^\[c\d+\] |$(?![\s\S]))/gm,
  )) {
    const mentioned = entities.filter((e) => row[2].split(', ').includes(e.ref))
    for (const excerpt of row[4].matchAll(/^\[(s\d+)\] ([\s\S]*?)(?=^\[s\d+\] |$(?![\s\S]))/gm)) {
      for (const { m, predicate } of relationships(excerpt[2])) {
        const subject = mentioned.find((e) => fold(e.label) === fold(m[1]))?.ref
        const object = mentioned.find((e) => fold(e.label) === fold(m[2]))?.ref
        if (!subject || !object || row[3].includes(`${subject} ${predicate} ${object}`)) continue
        links.push({
          claim: row[1],
          subject,
          predicate,
          object,
          segment: excerpt[1],
          quote: m[0].trim(),
        })
      }
    }
  }
  return { links }
}

function answer(input, fold) {
  if (input.stage === 'extract') return extract(input, fold)
  if (input.stage === 'links') return links(input, fold)
  return {
    decisions: input.rows.map((row) => {
      if (input.stage === 'identity') {
        const same = row.candidates.find((c) => fold(c.label) === fold(row.entity.label))
        return {
          ref: row.entity.ref,
          action: same ? 'reuse' : 'new',
          candidate: same?.handle ?? null,
          reason: same ? 'Same fixture label' : 'No matching fixture label',
        }
      }
      const same = row.candidates.find((c) => fold(c.summary) === fold(row.claim.memory.summary))
      return {
        ref: row.claim.ref,
        action: same ? 'confirm' : 'add',
        target: same?.handle ?? null,
        reason: same ? 'Same fixture sentence' : 'New fixture sentence',
      }
    }),
  }
}

function failOnce(stage) {
  const directory = process.env.PHOSPHOR_STUB_BRAIN_FAIL_ONCE
  if (stage !== 'extract' || !directory) return false
  fs.mkdirSync(directory, { recursive: true })
  // Fail one job, including its automatic transport retry, so UI Retry remains exercised.
  for (const attempt of [1, 2]) {
    try {
      fs.writeFileSync(path.join(directory, `failed-attempt-${attempt}`), 'extract\n', {
        flag: 'wx',
      })
      return true
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  return false
}

/** Only called by the existing unpackaged-app pi stub hook; no provider or network access. */
async function runBrain(argv) {
  try {
    if (!argv.includes('--no-tools') || !hasGuard(argv))
      throw new Error('Brain call is missing the no-tools guard or guard extension')
    const system = fs.readFileSync(argv[argv.indexOf('--system-prompt') + 1], 'utf8')
    let prompt = ''
    process.stdin.setEncoding('utf8')
    for await (const chunk of process.stdin) prompt += chunk
    const input = stageInput(system, prompt)
    if (failOnce(input.stage)) throw new Error('Brain stub extract failed once')
    // Keep extraction visible across one real queue poll.
    if (input.stage === 'extract') await new Promise((resolve) => setTimeout(resolve, 3000))
    const { fold } = await import('@phosphor/memory-engine/text')
    emit(answer(input, fold))
  } catch (error) {
    emit(null, error.message)
  }
}

// RPC-lane scenarios use the real local bridge; the stub never loads pi extensions.
const net = require('node:net')
const connected = () => !!process.env.PHOSPHOR_BRAIN_ENDPOINT && !!process.env.PHOSPHOR_BRAIN_TOKEN
const brainFolder = () =>
  path.basename(process.cwd()) === 'Brain' && path.basename(path.dirname(process.cwd())) === 'brain'
const isBrainLane = () => brainFolder() && connected()
let agentTurn = null

function recordAgentLaunch(argv) {
  const audit = process.env.PHOSPHOR_STUB_BRAIN_AUDIT
  if (audit)
    fs.appendFileSync(
      audit,
      JSON.stringify({
        cwd: process.cwd(),
        pid: process.pid,
        hasToken: connected(),
        curator: argv.some((arg) => arg.endsWith('brain-curator.mjs')),
      }) + '\n',
    )
}
function bridge(method, params) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(process.env.PHOSPHOR_BRAIN_ENDPOINT)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.setTimeout(10000, () => socket.destroy(new Error('Brain stub bridge timed out')))
    socket.on('error', reject)
    socket.on('connect', () =>
      socket.write(
        JSON.stringify({
          version: 6,
          token: process.env.PHOSPHOR_BRAIN_TOKEN,
          method,
          params,
        }) + '\n',
      ),
    )
    socket.on('data', (chunk) => {
      buffer += chunk
      if (buffer.length > 512 * 1024)
        return socket.destroy(new Error('Brain stub response too large'))
      if (!buffer.includes('\n')) return
      socket.end()
      try {
        resolve(JSON.parse(buffer.slice(0, buffer.indexOf('\n'))))
      } catch {
        reject(new Error('Invalid Brain stub response'))
      }
    })
    socket.on('end', () => {
      if (!buffer.includes('\n')) reject(new Error('Empty Brain stub response'))
    })
  })
}
/** Every page of a read, as Brain Agent opens it: each page says where to go on. */
async function readPages(jobId) {
  const pages = []
  let offset
  for (let page = 0; page < 100; page++) {
    const review = await bridge('readReview', offset === undefined ? { jobId } : { jobId, offset })
    if (!review.ok) throw new Error(review.error)
    pages.push(review.data.text)
    const next = /Call again with offset (\d+)\./.exec(review.data.text)
    if (!next) return pages
    offset = Number(next[1])
  }
  throw new Error('Brain stub read has too many pages')
}
/** Each uncertain identity a page asks about: the same-label candidate, or new. */
function identityAnswers(text) {
  return [
    ...text.matchAll(/^- (\S+) · (.+?) \(\w+\) · uncertain\b.*? · candidates: (.*?) · /gm),
  ].map(([, ref, label, candidates]) => ({
    ref,
    answer:
      candidates
        .split('; ')
        .map((candidate) => /^(\S+) = (.+?) \(/.exec(candidate))
        .find((match) => match?.[2] === label)?.[1] ?? 'new',
  }))
}
async function approveFirstRead() {
  const waiting = await bridge('waiting', { limit: 60 })
  if (!waiting.ok) throw new Error(waiting.error)
  const read = waiting.data.items.find((item) => item.kind === 'read')
  if (!read) return
  const pages = await readPages(read.jobId)
  const revision = Number(/ · revision (\d+)\./.exec(pages[0])[1])
  const choices = pages[0].includes('Brain never reads this lane')
    ? { approve: false }
    : { approve: true, identities: pages.flatMap(identityAnswers) }
  const result = await bridge('decideRead', {
    jobId: read.jobId,
    revision,
    ...choices,
    reason: 'The lasting memories have evidence in this read.',
  })
  if (!result.ok || result.data.status !== 'done')
    throw new Error(result.error ?? result.data.message)
}
function finishAgent(turn, text, error = false) {
  if (agentTurn !== turn) return
  agentTurn = null
  const message = {
    role: 'assistant',
    content: [{ type: 'text', text }],
    provider: 'stub',
    model: 'stub-model',
    stopReason: error ? 'error' : 'stop',
    ...(error ? { errorMessage: text } : {}),
  }
  turn.out({ type: 'message_start', message })
  turn.persist(message)
  turn.out({ type: 'message_end', message })
  turn.out({ type: 'agent_end', messages: [message] })
  turn.out({ type: 'agent_settled', aborted: false })
}
function handleAgentPrompt(message, out, persist) {
  if (!isBrainLane() || !(message.startsWith('Defrag.') || message.includes('BRAIN_STUB_HOLD')))
    return false
  const turn = { out, persist, timer: null }
  agentTurn = turn
  persist({ role: 'user', content: message })
  out({ type: 'agent_start' })
  const hold = process.env.PHOSPHOR_STUB_BRAIN_HOLD
  const marker = message + (hold && fs.existsSync(hold) ? fs.readFileSync(hold, 'utf8') : '')
  if (marker.includes('BRAIN_STUB_HOLD')) return true
  turn.timer = setTimeout(() => {
    approveFirstRead()
      .then(() => finishAgent(turn, 'Decided the waiting read.'))
      .catch((error) => finishAgent(turn, error.message, true))
  }, 2500)
  return true
}
function abortAgent() {
  if (!agentTurn) return false
  const turn = agentTurn
  agentTurn = null
  clearTimeout(turn.timer)
  turn.out({ type: 'agent_end', messages: [] })
  turn.out({ type: 'agent_settled', aborted: true })
  return true
}
module.exports = {
  isBrainCall,
  runBrain,
  isBrainLane,
  recordAgentLaunch,
  handleAgentPrompt,
  abortAgent,
}
