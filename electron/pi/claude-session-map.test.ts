import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { claudeSessionIdFor } from './claude-session-map'

/**
 * The sidecar belongs to another program, so every failure mode it can
 * present has to end in "no mapping" rather than an exception: a session
 * delete and a debug-info copy both call this on a path where throwing would
 * abort the user's action.
 */
describe('claudeSessionIdFor', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'phosphor-session-map-'))
    process.env.PI_CLAUDE_CLI_STATE_DIR = join(root, 'state')
  })

  afterEach(async () => {
    delete process.env.PI_CLAUDE_CLI_STATE_DIR
    await rm(root, { recursive: true, force: true })
  })

  async function writeMap(contents: string): Promise<void> {
    const dir = process.env.PI_CLAUDE_CLI_STATE_DIR!
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session-map.json'), contents, 'utf8')
  }

  it('reads the CLI session paired with a pi session', async () => {
    // Verbatim shape from a real ~/.pi/agent/pi-claude-cli/session-map.json.
    await writeMap(
      JSON.stringify({
        '01a04609-2e06-7428-b368-7e7871eb3814': 'dea87c8e-4de1-4f0e-9d5b-9a3c2f10c0b7',
      }),
    )
    expect(await claudeSessionIdFor('01a04609-2e06-7428-b368-7e7871eb3814')).toBe(
      'dea87c8e-4de1-4f0e-9d5b-9a3c2f10c0b7',
    )
  })

  it('returns null for a session the map has never seen', async () => {
    await writeMap(JSON.stringify({ other: 'x' }))
    expect(await claudeSessionIdFor('01a04609-2e06-7428-b368-7e7871eb3814')).toBeNull()
  })

  it('returns null when the sidecar is missing, corrupt or the wrong shape', async () => {
    expect(await claudeSessionIdFor('anything')).toBeNull()
    await writeMap('{not json')
    expect(await claudeSessionIdFor('anything')).toBeNull()
    await writeMap('["a","b"]')
    expect(await claudeSessionIdFor('anything')).toBeNull()
    await writeMap(JSON.stringify({ anything: 42 }))
    expect(await claudeSessionIdFor('anything')).toBeNull()
  })
})
