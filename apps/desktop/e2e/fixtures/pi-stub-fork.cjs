'use strict'
const fs = require('node:fs')

/**
 * Brain's knowledge fork: `pi -p --mode json --fork <lane> … <instruction>`.
 * Reads the forked lane and answers with one memory per "<Person> owns <thing>."
 * sentence the user wrote, quoting it exactly, as pi's JSON event stream does.
 * A fork that could call tools gets an error instead of an answer.
 */
function runFork(argv) {
  const source = argv[argv.indexOf('--fork') + 1]
  const guarded =
    argv.includes('--no-tools') && argv.some((arg) => arg.endsWith('brain-fork-guard.mjs'))
  const said = fs
    .readFileSync(source, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type === 'message' && entry.message?.role === 'user')
    .map((entry) => String(entry.message.content))
  const entities = new Map()
  const memories = []
  for (const text of said) {
    for (const [sentence, owner, thing] of text.matchAll(
      /([A-Z][a-z]+ [A-Z][a-z]+) owns (?:the )?([^.]+)\./g,
    )) {
      const key = (label) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-')
      entities.set(key(owner), { key: key(owner), label: owner, kind: 'person', aliases: [] })
      entities.set(key(thing), { key: key(thing), label: thing, kind: 'component', aliases: [] })
      memories.push({
        subject: key(owner),
        predicate: 'owns',
        object: key(thing),
        literal: null,
        summary: sentence,
        kind: 'reported',
        type: 'fact',
        branch: false,
        validFrom: null,
        quotes: [sentence],
        supersedes: null,
      })
    }
  }
  const answer = {
    summary: 'The lane named who owns what.',
    entities: [...entities.values()],
    memories,
  }
  const message = {
    role: 'assistant',
    content: [{ type: 'text', text: guarded ? JSON.stringify(answer) : '' }],
    provider: 'stub',
    model: 'stub-model',
    usage: { totalTokens: 1234, cost: { total: 0 } },
    stopReason: guarded ? 'stop' : 'error',
    ...(guarded ? {} : { errorMessage: 'The knowledge fork was started with tools.' }),
  }
  for (const event of [
    { type: 'agent_start' },
    { type: 'message_end', message },
    { type: 'agent_end', messages: [message] },
  ])
    process.stdout.write(JSON.stringify(event) + '\n')
  process.exit(0)
}

module.exports = { runFork }
