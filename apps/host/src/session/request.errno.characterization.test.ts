import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import type * as PromiseFs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseSessionRequest } from './request'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof PromiseFs>()
  return { ...original, lstat: vi.fn(original.lstat) }
})

let root: string
let repository: string
let session: string
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'host-request-errno-'))
  repository = join(root, 'repo')
  mkdirSync(repository)
  vi.stubEnv('PI_CODING_AGENT_DIR', join(root, 'agent'))
  vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', undefined)
  mkdirSync(sessionDirForCwd(repository), { recursive: true })
  session = join(sessionDirForCwd(repository), 'session.jsonl')
})
afterEach(() => {
  vi.resetAllMocks()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe('session request errno adoption', () => {
  it.each([
    [
      'ENOENT Error',
      Object.assign(new Error('private path'), { code: 'ENOENT' }),
      'does not exist',
    ],
    ['ENOENT record', { code: 'ENOENT' }, 'does not exist'],
    [
      'EACCES Error',
      Object.assign(new Error('private path'), { code: 'EACCES' }),
      'cannot be read',
    ],
    ['EIO record', { code: 'EIO' }, 'cannot be read'],
    ['uncoded Error', new Error('private path'), 'cannot be read'],
  ])('distinguishes %s without exposing its detail', async (_name, error, message) => {
    vi.mocked(fs.lstat).mockRejectedValueOnce(error)
    expect(await parseSessionRequest({ repository, sessionPath: session }, [repository])).toEqual({
      ok: false,
      errors: [{ pointer: '/sessionPath', message }],
    })
    expect(fs.lstat).toHaveBeenCalledExactlyOnceWith(session)
  })

  it.each(['ENOENT', 'EACCES'])(
    'does not inspect an outside session even if lstat would fail with %s',
    async (code) => {
      vi.mocked(fs.lstat).mockRejectedValueOnce(Object.assign(new Error('secret'), { code }))
      expect(
        await parseSessionRequest({ repository, sessionPath: join(repository, 'outside.jsonl') }, [
          repository,
        ]),
      ).toEqual({
        ok: false,
        errors: [
          {
            pointer: '/sessionPath',
            message: "must be in pi's session folder for this repository",
          },
        ],
      })
      expect(fs.lstat).not.toHaveBeenCalled()
    },
  )
})
