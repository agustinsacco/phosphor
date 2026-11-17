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
  if (system.startsWith('Check Brain Tidy pairs'))
    return {
      stage: 'tidy',
      rows: JSON.parse(prompt.split('authority="none">\n')[1].split('\n</background-data>')[0]),
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
  if (input.stage === 'tidy') return tidy(input.rows, fold)
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

function tidy(rows, fold) {
  return {
    decisions: rows.map(({ ref, a, b }) => {
      const same =
        a.type === 'memory' && b.type === 'memory'
          ? fold(a.sentence) === fold(b.sentence) &&
            ['memoryType', 'scope', 'branch', 'validFrom', 'validTo'].every(
              (key) => a[key] === b[key],
            )
          : a.type === 'entity' &&
            b.type === 'entity' &&
            a.kind === b.kind &&
            ((!!a.description && fold(a.description) === fold(b.description)) ||
              (fold(a.name).split(' ')[0] === fold(b.name).split(' ')[0] &&
                a.neighbours.some((left) =>
                  b.neighbours.some(
                    (right) => fold(left.name) === fold(right.name) && left.link === right.link,
                  ),
                )))
      return {
        ref,
        verdict: same ? 'same' : 'different',
        reason: same ? 'Same supported fixture assertion.' : 'No matching fixture evidence.',
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
    // The inbox polls every two seconds: keep this stage visible across one real poll.
    if (['extract', 'tidy'].includes(input.stage))
      await new Promise((resolve) => setTimeout(resolve, 3000))
    const { fold } = await import('@phosphor/memory-engine/text')
    emit(answer(input, fold))
  } catch (error) {
    emit(null, error.message)
  }
}

module.exports = { isBrainCall, runBrain }
