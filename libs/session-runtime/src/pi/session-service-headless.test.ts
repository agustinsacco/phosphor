import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

it('executes the complete session service in a plain Node subprocess', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phosphor-headless-'))
  try {
    const session = join(dir, 'session.jsonl')
    await writeFile(
      session,
      JSON.stringify({ type: 'session', version: 3, id: 'fixture-session', cwd: dir }) + '\n',
    )
    const library = resolve(import.meta.dirname, '../..')
    const bundle = await build({
      absWorkingDir: library,
      entryPoints: [join(import.meta.dirname, '__fixtures__/session-service-probe.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false,
      metafile: true,
      tsconfig: join(library, 'tsconfig.json'),
    })
    expect(
      Object.keys(bundle.metafile.inputs).filter((path) => /(^|\/)electron\//.test(path)),
    ).toEqual([])
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        bundle.outputFiles[0]!.text,
        join(import.meta.dirname, '__fixtures__/fake-pi.cjs'),
        dir,
        session,
      ],
      { timeout: 15000 },
    )
    expect(JSON.parse(stdout)).toEqual({
      plainNode: true,
      resumeReuse: true,
      streamed: true,
      routineGuard: true,
      providerGuard: true,
      interruptBypass: true,
      crashResume: true,
      deletion: true,
      shutdownAdmission: true,
      remaining: 0,
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
