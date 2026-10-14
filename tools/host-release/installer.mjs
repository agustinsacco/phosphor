import { URL } from 'node:url'
import { readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { contract, isEntryPoint } from './common.mjs'

/** ssh-keygen allowed_signers lines for the pinned release keys. */
export function allowedSigners(keys = contract.HOST_RELEASE_KEYS) {
  return keys
    .map(({ id, publicKey }) => {
      if (
        !/^[A-Za-z0-9._-]{1,64}$/.test(id) ||
        !/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}(?: [^\r\n]*)?$/.test(publicKey)
      )
        throw new Error('Invalid release public key')
      return `phosphor-release namespaces="phosphor-host-release" ${publicKey.split(' ').slice(0, 2).join(' ')}`
    })
    .join('\n')
}
/** Embed the sole pinned key source into the distributed POSIX installer. */
export function generateInstaller(path, keys = contract.HOST_RELEASE_KEYS) {
  const template = readFileSync(new URL('install.sh.in', import.meta.url), 'utf8')
  writeFileSync(path, template.replace('@ALLOWED_SIGNERS@', allowedSigners(keys)), {
    mode: 0o755,
  })
}
// The release workflow refuses to publish when no key is pinned, and verifies the
// signed manifest against exactly these lines before publishing.
if (isEntryPoint(import.meta.url)) {
  const { values } = parseArgs({
    options: { require: { type: 'boolean' }, 'allowed-signers': { type: 'boolean' } },
  })
  if (contract.HOST_RELEASE_KEYS.length === 0) {
    process.stderr.write('No Host release key is pinned in HOST_RELEASE_KEYS.\n')
    process.exit(1)
  }
  if (values['allowed-signers']) process.stdout.write(`${allowedSigners()}\n`)
}
