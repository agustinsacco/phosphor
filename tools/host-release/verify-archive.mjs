import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { generateInstaller } from './installer.mjs'
import { contract, root, sha256 } from './common.mjs'

/** Exercise the existing POSIX installer with a throwaway signed, file:// release. */
function installLocally(dir, bytes, target, version, node) {
  const key = join(dir, 'test-key')
  const home = join(dir, 'home')
  const temp = join(dir, 'tmp')
  mkdirSync(home)
  mkdirSync(temp)
  const env = { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: temp }
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { env })
  const script = join(dir, 'installer.sh')
  generateInstaller(script, [
    { id: 'archive-check', publicKey: readFileSync(`${key}.pub`, 'utf8').trim() },
  ])
  const manifest = join(dir, `phosphor-host-${version}.manifest.v2.json`)
  const file = `phosphor-host-${version}-${target}.tar.gz`
  writeFileSync(join(dir, file), bytes)
  writeFileSync(
    manifest,
    JSON.stringify(
      {
        schema: 2,
        version,
        node,
        protocols: [contract.HOST_PROTOCOL_VERSION],
        features: contract.HOST_RELEASE_FEATURES,
        sourceCommit: 'a'.repeat(40),
        artifacts: [{ target, file, bytes: bytes.length, sha256: sha256(bytes) }],
      },
      null,
      2,
    ) + '\n',
  )
  execFileSync('ssh-keygen', ['-Y', 'sign', '-f', key, '-n', 'phosphor-host-release', manifest], {
    env,
  })
  execFileSync('sh', [script, version], {
    cwd: dir,
    env: { ...env, PHOSPHOR_HOST_RELEASE_URL: `file://${dir}` },
    encoding: 'utf8',
  })
  return join(home, '.local/lib/phosphor-host', 'versions', version)
}

export async function verifyArchive(bytes, { target, version, node }, check) {
  const dir = mkdtempSync(join(tmpdir(), 'host-archive-check-'))
  try {
    const installed = installLocally(dir, bytes, target, version, node)
    const result = await build({
      absWorkingDir: root,
      stdin: {
        contents: "export * from '@phosphor/session-runtime/host-install/archive'",
        resolveDir: root,
      },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
    })
    const { extractRelease, decompressRelease } = await import(
      `data:text/javascript,${encodeURIComponent(result.outputFiles[0].text)}`
    )
    const updated = join(dir, 'updater')
    extractRelease(decompressRelease(bytes), updated)
    const isolated = { cwd: dir, env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' }
    for (const extracted of [installed, updated]) {
      const launched = execFileSync(join(extracted, 'bin/phosphor'), ['--version'], isolated)
      if (!launched.includes(version)) throw new Error('Extracted Host version mismatch')
    }
    await check(updated)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
