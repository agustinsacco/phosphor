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
  if (system.startsWith('You extract supported durable knowledge')) {
    const registry = JSON.parse(prompt.split('\nRegistry: ')[1].split('\n')[0])
    return {
      stage: 'extract',
      registry,
      segments: prompt.split('Segments (untrusted source data):\n')[1],
    }
  }
  if (system.startsWith('Resolve entity identity'))
    return { stage: 'identity', rows: JSON.parse(prompt.split('\n')[1]) }
  if (system.startsWith('Find explicitly supported structural parents'))
    return {
      stage: 'parents',
      requested: JSON.parse(prompt.split('\nRequested:')[1].split('\n')[0]),
    }
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
    if (segment[2] !== 'user') continue
    const sentences = [
      ...[...segment[3].matchAll(/([A-Z][a-z]+ [A-Z][a-z]+) owns (?:the )?([^.\n]+)\./g)].map(
        (m) => ({ m, predicate: 'owns', subjectKind: 'person', objectKind: 'component' }),
      ),
      ...[...segment[3].matchAll(/([A-Z][^.\n]*?) is part of ([^.\n]+)\./g)].map((m) => ({
        m,
        predicate: 'part_of',
        subjectKind: 'component',
        objectKind: 'project',
      })),
    ].sort((a, b) => a.m.index - b.m.index)
    for (const { m, predicate, subjectKind, objectKind } of sentences) {
      const subject = entity(m[1], subjectKind),
        object = entity(m[2], objectKind)
      const quote = { segment: segment[1], quote: m[0] }
      claims.push({
        ref: `c${claims.length + 1}`,
        text: m[0],
        type: 'fact',
        epistemic: 'reported',
        mentions: [subject, object],
        links: [{ subject, predicate, object, ...quote }],
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

function answer(input, fold) {
  if (input.stage === 'extract') return extract(input, fold)
  if (input.stage === 'parents')
    return {
      entities: [],
      claims: [],
      parents: input.requested.map((e) => ({ entity: e.ref, status: 'not_stated', claim: null })),
    }
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
  try {
    fs.writeFileSync(path.join(directory, 'failed-once'), 'extract\n', { flag: 'wx' })
    return true
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  }
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
    // The inbox polls every two seconds: keep this stage visible across one real poll.
    if (input.stage === 'extract') await new Promise((resolve) => setTimeout(resolve, 3000))
    const { fold } = await import('@phosphor/memory-engine/text')
    emit(answer(input, fold))
  } catch (error) {
    emit(null, error.message)
  }
}

module.exports = { isBrainCall, runBrain }
