import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import type * as ChildProcessModule from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type * as OsModule from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  isOrphanedUpdateEntry,
  stageMacUpdate,
  type StageOptions,
  type StagedMacUpdate,
} from './mac-installer'

/**
 * `stageMacUpdate` through its public entry. Only the two boundaries a test
 * machine cannot provide are faked: the network (`fetch`) and the macOS tools
 * it spawns (`ditto`, `xattr`, `codesign`, `PlistBuddy`, `/bin/rm`). The fake
 * tools act on the real temp filesystem, so staging, extraction and cleanup
 * are observed on disk rather than inferred from calls. `tmpdir()` points at a
 * per-test directory so the downloaded zip's own cleanup is observable too.
 */
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcessModule>()),
  spawn: vi.fn(),
}))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof OsModule>()
  return { ...actual, tmpdir: vi.fn(actual.tmpdir) }
})

type ToolOutcome = { code: number; stdout?: string; stderr?: string } | Error
type Tool = (args: string[]) => Promise<ToolOutcome>

const REAL_TMP = tmpdir()
const STAMP = 1756330000000
const VERSION = '9.9.9'
const ZIP_URL = `https://github.com/agustinsacco/Phosphor/releases/download/v${VERSION}/phosphor-${VERSION}-arm64-mac.zip`
const ARCHIVE = ['PK', '\u0003\u0004', 'x'.repeat(296)]
const OK: ToolOutcome = { code: 0 }

let root: string
let parent: string
let installed: string
let downloads: string
let calls: { tool: string; args: string[] }[]
let events: string[]
let extracted: string | null
let tools: Record<string, Tool>

function sha512(chunks: string[]): string {
  return createHash('sha512').update(chunks.join('')).digest('base64')
}

/** What `ditto` would leave behind for a well-formed release zip. */
async function writeBundle(dest: string, version: string): Promise<void> {
  await mkdir(join(dest, 'Phosphor.app', 'Contents'), { recursive: true })
  await writeFile(join(dest, 'Phosphor.app', 'Contents', 'Info.plist'), version)
}

function defaultTools(): Record<string, Tool> {
  return {
    '/usr/bin/ditto': async ([, , zip, dest]) => {
      extracted = await readFile(zip!, 'utf8')
      await writeBundle(dest!, VERSION)
      return OK
    },
    '/usr/bin/xattr': async () => OK,
    '/usr/bin/codesign': async () => OK,
    '/usr/libexec/PlistBuddy': async ([, , plist]) => {
      const text = await readFile(plist!, 'utf8').catch(() => null)
      return text === null
        ? { code: 1, stderr: "File Doesn't Exist" }
        : { code: 0, stdout: `${text}\n` }
    },
    '/bin/rm': async ([, , path]) => {
      await rm(path!, { recursive: true, force: true })
      return OK
    },
  }
}

function fakeChild(command: string, args: readonly string[]): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  })
  calls.push({ tool: command, args: [...args] })
  events.push(`spawn ${basename(command)}`)
  const tool = tools[command] ?? (async () => new Error(`unexpected ${command}`))
  void tool([...args]).then((outcome) => {
    if (outcome instanceof Error) return void child.emit('error', outcome)
    if (outcome.stdout) child.stdout.emit('data', Buffer.from(outcome.stdout))
    if (outcome.stderr) child.stderr.emit('data', Buffer.from(outcome.stderr))
    child.emit('close', outcome.code)
  })
  return child as unknown as ChildProcess
}

function serve(chunks: string[], length?: number): ReturnType<typeof vi.fn> {
  const encoder = new TextEncoder()
  const fetchMock = vi.fn(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
            controller.close()
          },
        }),
        { headers: length === undefined ? {} : { 'content-length': String(length) } },
      ),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function stage(overrides: Partial<StageOptions> = {}): Promise<StagedMacUpdate> {
  return stageMacUpdate({
    bundlePath: installed,
    version: VERSION,
    zipUrl: ZIP_URL,
    sha512: sha512(ARCHIVE),
    onProgress: (percent) => events.push(`progress ${percent}`),
    onInstallStart: () => events.push('install-start'),
    ...overrides,
  })
}

const stagingDir = (): string => join(parent, `.phosphor-update-${process.pid}-${STAMP}`)
const toolsRun = (): string[] => calls.map((call) => basename(call.tool))

beforeEach(async () => {
  root = await mkdtemp(join(REAL_TMP, 'phosphor-stage-test-'))
  parent = join(root, 'Applications')
  installed = join(parent, 'Phosphor.app')
  downloads = join(root, 'tmp')
  await mkdir(installed, { recursive: true })
  await writeFile(join(installed, 'marker'), 'old')
  await mkdir(downloads)
  calls = []
  events = []
  extracted = null
  tools = defaultTools()
  vi.mocked(tmpdir).mockReturnValue(downloads)
  vi.mocked(spawn).mockImplementation(fakeChild as unknown as typeof spawn)
  vi.spyOn(Date, 'now').mockReturnValue(STAMP)
  serve(ARCHIVE, 300)
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.mocked(spawn).mockReset()
  await rm(root, { recursive: true, force: true })
})

describe('stageMacUpdate (characterization)', () => {
  it('stages a verified bundle in a sibling directory of the installed one', async () => {
    const staged = await stage()

    expect(staged).toEqual({
      version: VERSION,
      stagingDir: stagingDir(),
      stagedBundle: join(stagingDir(), 'Phosphor.app'),
    })
    expect(dirname(staged.stagingDir)).toBe(parent)
    expect(isOrphanedUpdateEntry(basename(staged.stagingDir))).toBe(true)
    expect(existsSync(join(staged.stagedBundle, 'Contents', 'Info.plist'))).toBe(true)
    await expect(readFile(join(installed, 'marker'), 'utf8')).resolves.toBe('old')
    // The zip lived in the system temp dir and is gone once staging returns.
    await expect(readdir(downloads)).resolves.toEqual([])
    expect(toolsRun()).not.toContain('rm')
  })

  it('fetches the given URL, following redirects, with the caller signal', async () => {
    const fetchMock = serve(ARCHIVE, 300)
    const controller = new AbortController()

    await stage({ signal: controller.signal })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(ZIP_URL, {
      redirect: 'follow',
      signal: controller.signal,
    })
  })

  it('extracts the verified download with ditto, then strips quarantine, verifies and reads the version', async () => {
    const staged = await stage()

    expect(toolsRun()).toEqual(['ditto', 'xattr', 'codesign', 'PlistBuddy'])
    const zip = calls[0]!.args[2]!
    expect(basename(zip)).toBe('phosphor.zip')
    expect(basename(dirname(zip))).toMatch(/^phosphor-update-/)
    expect(dirname(dirname(zip))).toBe(downloads)
    expect(extracted).toBe(ARCHIVE.join(''))
    expect(calls.map((call) => call.args)).toEqual([
      ['-x', '-k', zip, staged.stagingDir],
      ['-dr', 'com.apple.quarantine', staged.stagedBundle],
      ['--verify', '--deep', '--strict', staged.stagedBundle],
      [
        '-c',
        'Print :CFBundleShortVersionString',
        join(staged.stagedBundle, 'Contents', 'Info.plist'),
      ],
    ])
  })

  it('reports whole-percent progress, then install start, before extraction', async () => {
    serve(['P', 'K', 'x'.repeat(98), 'x'.repeat(100), 'x'.repeat(100)], 300)

    await stage({ sha512: sha512(['PK', 'x'.repeat(298)]) })

    expect(events).toEqual([
      'progress 0',
      'progress 33',
      'progress 66',
      'progress 100',
      'install-start',
      'spawn ditto',
      'spawn xattr',
      'spawn codesign',
      'spawn PlistBuddy',
    ])
  })

  it('caps progress at 100 when the body outruns its content-length', async () => {
    serve(['x'.repeat(50), 'x'.repeat(50), 'x'.repeat(50)], 100)

    await stage({ sha512: sha512(['x'.repeat(150)]) })

    expect(events.filter((event) => event.startsWith('progress'))).toEqual([
      'progress 50',
      'progress 100',
    ])
  })

  it('reports no progress when the response has no content-length', async () => {
    serve(ARCHIVE)

    await stage()

    expect(events[0]).toBe('install-start')
  })

  it('aborts on a sha512 mismatch before install start or extraction', async () => {
    await expect(stage({ sha512: sha512(['tampered']) })).rejects.toThrow(
      `sha512 mismatch for phosphor-${VERSION}-arm64-mac.zip`,
    )

    expect(events).toEqual(['progress 0', 'progress 1', 'progress 100', 'spawn rm'])
    expect(calls).toEqual([{ tool: '/bin/rm', args: ['-rf', '--', stagingDir()] }])
    expect(extracted).toBeNull()
    expect(existsSync(stagingDir())).toBe(false)
    await expect(readdir(downloads)).resolves.toEqual([])
  })

  it('fails a non-OK download before hashing, progress or staging', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('missing', { status: 404 })),
    )

    await expect(stage()).rejects.toThrow('download failed: HTTP 404')

    expect(events).toEqual(['spawn rm'])
    expect(existsSync(stagingDir())).toBe(false)
    await expect(readdir(downloads)).resolves.toEqual([])
  })

  it('fails a download that has no body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    )

    await expect(stage()).rejects.toThrow('download failed: HTTP 200')
    expect(events).toEqual(['spawn rm'])
  })

  it('rethrows the fetch failure itself and still cleans up', async () => {
    const aborted = new DOMException('This operation was aborted', 'AbortError')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw aborted
      }),
    )

    await expect(stage()).rejects.toBe(aborted)
    expect(calls).toEqual([{ tool: '/bin/rm', args: ['-rf', '--', stagingDir()] }])
    await expect(readdir(downloads)).resolves.toEqual([])
  })

  it('stops at a failed extraction without verifying anything', async () => {
    tools['/usr/bin/ditto'] = async () => ({
      code: 1,
      stderr: "ditto: Couldn't read PKZip signature\n",
    })

    await expect(stage()).rejects.toThrow("ditto exited 1: ditto: Couldn't read PKZip signature")

    expect(toolsRun()).toEqual(['ditto', 'rm'])
    expect(calls[1]!.args).toEqual(['-rf', '--', stagingDir()])
    expect(existsSync(stagingDir())).toBe(false)
    await expect(readdir(downloads)).resolves.toEqual([])
  })

  it('rejects with the spawn error when a tool cannot start', async () => {
    const missing = Object.assign(new Error('spawn /usr/bin/ditto ENOENT'), { code: 'ENOENT' })
    tools['/usr/bin/ditto'] = async () => missing

    await expect(stage()).rejects.toBe(missing)
    expect(toolsRun()).toEqual(['ditto', 'rm'])
  })

  it('rejects an archive with no .app bundle inside', async () => {
    tools['/usr/bin/ditto'] = async ([, , , dest]) => {
      await writeFile(join(dest!, 'README'), 'not an app')
      return OK
    }

    await expect(stage()).rejects.toThrow('no .app bundle inside the downloaded archive')
    expect(toolsRun()).toEqual(['ditto', 'rm'])
    expect(existsSync(stagingDir())).toBe(false)
  })

  it('tolerates a failed quarantine strip and still verifies', async () => {
    tools['/usr/bin/xattr'] = async () => ({ code: 1, stderr: 'No such xattr' })

    await expect(stage()).resolves.toMatchObject({ version: VERSION })
    expect(toolsRun()).toEqual(['ditto', 'xattr', 'codesign', 'PlistBuddy'])
  })

  it('refuses a bundle that fails codesign before reading its version', async () => {
    tools['/usr/bin/codesign'] = async () => ({
      code: 3,
      stderr: 'a sealed resource is missing or invalid\n',
    })

    await expect(stage()).rejects.toThrow(
      'codesign exited 3: a sealed resource is missing or invalid',
    )

    expect(toolsRun()).toEqual(['ditto', 'xattr', 'codesign', 'rm'])
    expect(existsSync(stagingDir())).toBe(false)
    await expect(readFile(join(installed, 'marker'), 'utf8')).resolves.toBe('old')
  })

  it('refuses a bundle whose version is not the expected one', async () => {
    tools['/usr/bin/ditto'] = async ([, , , dest]) => {
      await writeBundle(dest!, '9.9.8')
      return OK
    }

    await expect(stage()).rejects.toThrow(`archive contains 9.9.8, expected ${VERSION}`)
    expect(toolsRun()).toEqual(['ditto', 'xattr', 'codesign', 'PlistBuddy', 'rm'])
    expect(existsSync(stagingDir())).toBe(false)
  })

  it('refuses a bundle whose version cannot be read', async () => {
    tools['/usr/bin/ditto'] = async ([, , , dest]) => {
      await mkdir(join(dest!, 'Phosphor.app'))
      return OK
    }

    await expect(stage()).rejects.toThrow(`archive contains no version, expected ${VERSION}`)
    expect(existsSync(stagingDir())).toBe(false)
  })

  it('keeps the original error when the staging cleanup also fails', async () => {
    tools['/bin/rm'] = async () => ({ code: 1, stderr: 'rm: Operation not permitted' })
    tools['/usr/bin/codesign'] = async () => ({ code: 3, stderr: 'invalid signature' })

    await expect(stage()).rejects.toThrow('codesign exited 3: invalid signature')

    expect(toolsRun()).toEqual(['ditto', 'xattr', 'codesign', 'rm'])
    // The failed cleanup leaves staging for the next launch's sweep, but the
    // download directory is removed independently of it.
    expect(existsSync(stagingDir())).toBe(true)
    await expect(readdir(downloads)).resolves.toEqual([])
  })

  it('keeps a sha512 mismatch as the error when the cleanup also fails', async () => {
    tools['/bin/rm'] = async () => new Error('spawn /bin/rm EACCES')

    await expect(stage({ sha512: 'not-the-hash' })).rejects.toThrow(
      `sha512 mismatch for phosphor-${VERSION}-arm64-mac.zip`,
    )
    expect(toolsRun()).toEqual(['rm'])
  })
})
