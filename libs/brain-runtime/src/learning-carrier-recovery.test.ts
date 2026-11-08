import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createSessionPathRuntime } from '@phosphor/session-runtime/pi/session-path-lock'
import { learningRootCreator } from './learning-carrier-recovery'
import { createLearningHost, type LearningHostOptions } from './learning-host'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'learning-recovery-')))
  roots.push(root)
  const directory = join(root, 'learning')
  await mkdir(directory)
  const options: LearningHostOptions = {
    directory,
    extensionPath: join(root, 'brain-learning-carrier.mjs'),
    sessionsRoot: join(root, 'sessions'),
    paths: createSessionPathRuntime(),
    registry: { list: () => [], get: () => undefined },
    sessions: {
      create: vi.fn(async () => {
        throw new Error('Unexpected spawn')
      }),
      disposeBrain: vi.fn(async () => {}),
    },
    resolve: vi.fn(async () => {
      throw new Error('Unexpected auth resolution')
    }),
    onError: vi.fn(),
  }
  return { root, directory, options, host: createLearningHost(options) }
}
async function interrupted(directory: string, name: string, writerState?: string) {
  const path = join(directory, `learning-${name}`)
  await mkdir(path)
  const marker = {
    version: 1,
    kind: 'brain-learning-root',
    jobId: 'preview-job',
    nonce: 'a'.repeat(64),
    ...learningRootCreator(),
    writerState,
  }
  await writeFile(join(path, 'owner.json'), JSON.stringify(marker))
  await writeFile(
    join(path, 'source.jsonl'),
    JSON.stringify({
      type: 'custom',
      customType: 'phosphor-brain-owner',
      data: { kind: 'brain', jobId: 'preview-job' },
    }) + '\n',
  )
  return path
}
it('fresh admission recovers an interrupted preview-only source root before resolving or spawning another carrier', async () => {
  const f = await fixture()
  const previous = await interrupted(f.directory, 'preview', 'never-started')
  await f.host
    .prepare(
      { workspacePath: '/not-an-existing-workspace', sessionPath: '/not-an-existing-session' },
      'next-job',
      new AbortController().signal,
    )
    .catch(() => undefined)
  await expect(readFile(join(previous, 'source.jsonl'))).rejects.toThrow()
  expect(f.options.resolve).not.toHaveBeenCalled()
  expect(f.options.sessions.create).not.toHaveBeenCalled()
})
it.each(['never-started', 'stopped'])(
  'explicit recovery and shutdown purge proven %s roots even without a job receipt',
  async (state) => {
    const f = await fixture()
    await interrupted(f.directory, 'known', state)
    const host = f.host as typeof f.host & { recover(): Promise<void>; dispose(): Promise<void> }
    await host.recover()
    await host.recover()
    await host.dispose()
    expect(await readdir(f.directory)).toEqual([])
  },
)
it.each(['possibly-running', undefined, 'unsupported'])(
  'retains uncertain or malformed roots visibly: %s',
  async (state) => {
    const f = await fixture(),
      previous = await interrupted(f.directory, 'uncertain', state)
    const original = await readFile(join(previous, 'source.jsonl'), 'utf8')
    const host = f.host as typeof f.host & { recover(): Promise<void>; dispose(): Promise<void> }
    await expect(host.recover()).rejects.toThrow(/retained|Retained/)
    await expect(host.dispose()).rejects.toThrow(/retained|Retained/)
    await expect(
      f.host.prepare(
        { workspacePath: '/missing', sessionPath: '/missing' },
        'job',
        new AbortController().signal,
      ),
    ).rejects.toThrow(/retained|Retained/)
    expect(await readFile(join(previous, 'source.jsonl'), 'utf8')).toBe(original)
    expect(f.options.sessions.disposeBrain).not.toHaveBeenCalled()
    expect(f.options.sessions.create).not.toHaveBeenCalled()
  },
)
it('preserves foreign markers, malformed JSON and root/file symlinks without following their targets', async () => {
  const f = await fixture(),
    previous = await interrupted(f.directory, 'foreign', 'stopped')
  const marker = join(previous, 'owner.json'),
    source = join(previous, 'source.jsonl')
  const original = await readFile(source, 'utf8')
  const host = f.host as typeof f.host & { recover(): Promise<void> }
  await writeFile(marker, '{malformed')
  await expect(host.recover()).rejects.toThrow(/retained|Retained/)
  await rm(marker)
  await symlink(source, marker)
  await expect(host.recover()).rejects.toThrow(/retained|Retained/)
  await rm(previous, { recursive: true })
  const target = join(f.root, 'foreign-target')
  await mkdir(target)
  await writeFile(join(target, 'untouched'), original)
  await symlink(target, previous)
  await expect(host.recover()).rejects.toThrow(/retained|Retained/)
  expect(await readFile(join(target, 'untouched'), 'utf8')).toBe(original)
})
it.each(['alive', 'EPERM', 'EIO', 'ESRCH'])(
  'uses PID existence only as conservative creator liveness evidence: %s',
  async (status) => {
    const f = await fixture(),
      previous = await interrupted(f.directory, 'creator', 'never-started')
    const path = join(previous, 'owner.json'),
      marker = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(
      path,
      JSON.stringify({ ...marker, creatorPid: 123456, creatorInstanceId: 'b'.repeat(64) }),
    )
    const probe = vi.spyOn(process, 'kill').mockImplementation(() => {
      if (status !== 'alive') throw Object.assign(new Error(status), { code: status })
      return true
    })
    try {
      if (status === 'ESRCH') {
        await f.host.recover()
        expect(await readdir(f.directory)).toEqual([])
      } else {
        await expect(f.host.recover()).rejects.toThrow('retained')
        expect(await readFile(join(previous, 'source.jsonl'), 'utf8')).toContain('preview-job')
      }
      expect(probe).toHaveBeenCalledExactlyOnceWith(123456, 0)
    } finally {
      probe.mockRestore()
    }
  },
)
it.each([0, -1, 2147483648, '123'])(
  'does not probe malformed stored PIDs: %s',
  async (creatorPid) => {
    const f = await fixture(),
      previous = await interrupted(f.directory, 'bad-pid', 'never-started')
    const path = join(previous, 'owner.json'),
      marker = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, JSON.stringify({ ...marker, creatorPid }))
    const probe = vi.spyOn(process, 'kill')
    try {
      await expect(f.host.recover()).rejects.toThrow('retained')
      expect(probe).not.toHaveBeenCalled()
    } finally {
      probe.mockRestore()
    }
  },
)
it('does not mistake a reused current PID with a different creator instance for ownership', async () => {
  const f = await fixture(),
    previous = await interrupted(f.directory, 'reused-pid', 'never-started')
  const path = join(previous, 'owner.json'),
    marker = JSON.parse(await readFile(path, 'utf8'))
  await writeFile(path, JSON.stringify({ ...marker, creatorInstanceId: 'b'.repeat(64) }))
  const probe = vi.spyOn(process, 'kill').mockReturnValue(true)
  try {
    await expect(f.host.recover()).rejects.toThrow('retained')
    expect(probe).toHaveBeenCalledExactlyOnceWith(process.pid, 0)
  } finally {
    probe.mockRestore()
  }
})
it('does not recover a root while a registered writer still owns its cwd, even with a stopped marker', async () => {
  const f = await fixture(),
    previous = await interrupted(f.directory, 'registered', 'stopped')
  f.options.registry.list = () => [{ sessionId: 'unknown', workspacePath: join(previous, 'cwd') }]
  await expect(f.host.recover()).rejects.toThrow('retained')
  expect(f.options.sessions.disposeBrain).not.toHaveBeenCalled()
  expect(await readFile(join(previous, 'source.jsonl'), 'utf8')).toContain('preview-job')
})
it('serializes another host recovery behind the same snapshot-and-writer-transition lock', async () => {
  const { withLearningRootRecovery, markLearningWriter } =
    await import('./learning-carrier-recovery')
  const f = await fixture()
  let entered = () => {},
    release = () => {}
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let previous = ''
  const preparation = withLearningRootRecovery(f.options, async () => {
    previous = await interrupted(f.directory, 'transition', 'never-started')
    entered()
    await gate
    await f.options.paths.withSessionPath(previous, () =>
      markLearningWriter(previous, 'preview-job', 'a'.repeat(64), 'possibly-running'),
    )
  })
  await started
  const other = createLearningHost(f.options)
  let finished = false
  const recovery = other.recover().finally(() => {
    finished = true
  })
  const rejection = expect(recovery).rejects.toThrow('retained')
  await Promise.resolve()
  expect(finished).toBe(false)
  expect(await readFile(join(previous, 'source.jsonl'), 'utf8')).toContain('preview-job')
  release()
  await preparation
  await rejection
})
it('retains legacy or foreign ownership instead of guessing which process created it', async () => {
  const f = await fixture(),
    previous = await interrupted(f.directory, 'legacy', 'stopped')
  const path = join(previous, 'owner.json')
  for (const marker of [
    { jobId: 'preview-job', nonce: 'a'.repeat(64) },
    {
      version: 1,
      kind: 'foreign-root',
      jobId: 'preview-job',
      nonce: 'a'.repeat(64),
      ...learningRootCreator(),
      writerState: 'stopped',
    },
  ]) {
    await writeFile(path, JSON.stringify(marker))
    await expect(f.host.recover()).rejects.toThrow('retained')
    expect(await readFile(join(previous, 'source.jsonl'), 'utf8')).toContain('preview-job')
  }
})
it('recovers an interrupted purge with only its durable owner marker left', async () => {
  const f = await fixture(),
    previous = await interrupted(f.directory, 'partial-purge', 'stopped')
  await rm(join(previous, 'source.jsonl'))
  await f.host.recover()
  await f.host.dispose()
  expect(await readdir(f.directory)).toEqual([])
})
