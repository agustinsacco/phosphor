import { chmodSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { HOST_SIDECARS } from '@phosphor/shared/host-local'
import { AGENT_POLICY_DEFAULT, type AgentPolicy } from '@phosphor/shared/ops'
import { loadSqlite } from '../lanes/sqlite'
import { ADDITIVE_SCHEMA } from '../lanes/store/additive'
import { createPolicyFile } from './policy-file'

const uid = process.getuid?.()
let directory: string
let db: DatabaseSync

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'host-policy-'))
  chmodSync(directory, 0o700)
  db = new (await loadSqlite()).DatabaseSync(':memory:')
  db.exec('CREATE TABLE lanes (lane_id TEXT PRIMARY KEY NOT NULL) STRICT;')
  db.exec(ADDITIVE_SCHEMA)
})

afterEach(() => {
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

const file = () => join(directory, HOST_SIDECARS.agentPolicy)
const store = () => createPolicyFile({ directory, uid, db, now: () => 1000 })
const strict: AgentPolicy = {
  ...AGENT_POLICY_DEFAULT,
  machineOps: 'read',
  tiers: { create: 'ask' },
  ops: { 'lane.rename': 'deny' },
}

/** The user edits the file by hand, as the owner-only JSON it is. */
function edit(policy: unknown) {
  writeFileSync(file(), JSON.stringify(policy), { mode: 0o600 })
  chmodSync(file(), 0o600)
}

it('reads the default policy before anything was written', async () => {
  expect(await store().read()).toEqual({ policy: AGENT_POLICY_DEFAULT, changedOutside: false })
})

it('reads back its own write, and leaves it owner-only', async () => {
  await store().write(strict)
  expect(await store().read()).toEqual({ policy: strict, changedOutside: false })
  expect(JSON.parse(readFileSync(file(), 'utf8'))).toMatchObject({ version: 1, machineOps: 'read' })
})

it('enforces the stricter of file and snapshot when the file was edited, and raises the banner', async () => {
  await store().write(strict)
  edit({ ...AGENT_POLICY_DEFAULT, machineOps: 'all', agentControl: 'read' })
  const read = await store().read()
  expect(read.changedOutside).toBe(true)
  expect(read.policy).toMatchObject({
    // Each key takes the stricter side: the snapshot's machineOps, the file's agentControl.
    machineOps: 'read',
    agentControl: 'read',
    tiers: { create: 'ask' },
    ops: { 'lane.rename': 'deny' },
  })
})

it('cannot be relaxed by removing or corrupting the file', async () => {
  await store().write(strict)
  unlinkSync(file())
  const removed = await store().read()
  expect(removed.changedOutside).toBe(true)
  expect(removed.policy).toMatchObject({ machineOps: 'read', tiers: { create: 'ask' } })
  writeFileSync(file(), 'not json', { mode: 0o600 })
  const corrupt = await store().read()
  expect(corrupt.changedOutside).toBe(true)
  expect(corrupt.policy).toMatchObject({ machineOps: 'read', ops: { 'lane.rename': 'deny' } })
})

it('lets a file it never wrote only tighten the default', async () => {
  edit({ ...AGENT_POLICY_DEFAULT, agentControl: 'off', ops: { 'lane.delete': 'allow' } })
  const read = await store().read()
  expect(read.changedOutside).toBe(true)
  expect(read.policy.agentControl).toBe('off')
  expect(read.policy.ops?.['lane.delete']).toBeUndefined()
})

it('clears the banner once the user saves a policy again', async () => {
  await store().write(strict)
  edit(AGENT_POLICY_DEFAULT)
  expect((await store().read()).changedOutside).toBe(true)
  await store().write(AGENT_POLICY_DEFAULT)
  expect(await store().read()).toEqual({ policy: AGENT_POLICY_DEFAULT, changedOutside: false })
})

it('refuses a policy file another user could write', async () => {
  await store().write(strict)
  chmodSync(file(), 0o644)
  const read = await store().read()
  expect(read.changedOutside).toBe(true)
  expect(read.policy).toMatchObject({ machineOps: 'read' })
})
