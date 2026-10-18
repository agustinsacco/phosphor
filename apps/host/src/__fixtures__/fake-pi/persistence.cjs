'use strict'
const { randomUUID } = require('node:crypto')
const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { dirname, join } = require('node:path')

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')

function createSession({ sessionFile, folder, cwd, launchName }) {
  sessionFile ??= join(folder, `${stamp()}_${randomUUID()}.jsonl`)
  const id = randomUUID()
  const messages = existsSync(sessionFile)
    ? readFileSync(sessionFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .flatMap((entry) => (entry.type === 'message' ? [entry.message] : []))
    : []
  const lastEntryId = existsSync(sessionFile)
    ? (JSON.parse(readFileSync(sessionFile, 'utf8').trim().split('\n').at(-1)).id ?? null)
    : null
  const selectedName = existsSync(sessionFile)
    ? readFileSync(sessionFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .findLast((entry) => entry.type === 'session_info')?.name
    : undefined
  return { sessionFile, id, cwd, launchName, messages, lastEntryId, selectedName }
}

function header(session) {
  return JSON.stringify({
    type: 'session',
    version: 3,
    id: session.id,
    timestamp: new Date().toISOString(),
    cwd: session.cwd,
  })
}

function ensureFile(session) {
  if (existsSync(session.sessionFile)) return false
  mkdirSync(dirname(session.sessionFile), { recursive: true })
  appendFileSync(session.sessionFile, header(session) + '\n')
  return true
}

function appendEntry(session, type, data) {
  const id = randomUUID()
  appendFileSync(
    session.sessionFile,
    JSON.stringify({ type, id, parentId: session.lastEntryId, ...data }) + '\n',
  )
  session.lastEntryId = id
}

/** Native JSONL entries form one parent-linked chain, including tools and names. */
function persist(session, message) {
  if (ensureFile(session) && session.launchName)
    appendEntry(session, 'session_info', { name: session.launchName })
  appendEntry(session, 'message', { message })
  session.messages.push(message)
}

function setName(session, name) {
  session.selectedName = name
  ensureFile(session)
  appendEntry(session, 'session_info', { name })
}

/** pi's clone: a new file with this one's entries, which pi then writes instead. */
function clone(session) {
  const entries = existsSync(session.sessionFile)
    ? readFileSync(session.sessionFile, 'utf8').split('\n').filter(Boolean).slice(1)
    : []
  session.id = randomUUID()
  session.sessionFile = join(dirname(session.sessionFile), `${stamp()}_${session.id}.jsonl`)
  mkdirSync(dirname(session.sessionFile), { recursive: true })
  writeFileSync(
    session.sessionFile,
    [header(session), ...entries].map((line) => line + '\n').join(''),
  )
}

module.exports = { createSession, persist, setName, clone }
