import { URL } from 'node:url'
import { readFileSync, writeFileSync } from 'node:fs'
import { contract } from './common.mjs'
/** Embed the sole pinned key source into the distributed POSIX installer. */
export function generateInstaller(path, keys = contract.HOST_RELEASE_KEYS) {
  const signers = keys
    .map(({ id, publicKey }) => {
      if (
        !/^[A-Za-z0-9._-]{1,64}$/.test(id) ||
        !/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}(?: [^\r\n]*)?$/.test(publicKey)
      )
        throw new Error('Invalid release public key')
      return `phosphor-release namespaces="phosphor-host-release" ${publicKey.split(' ').slice(0, 2).join(' ')}`
    })
    .join('\n')
  const template = readFileSync(new URL('install.sh.in', import.meta.url), 'utf8')
  writeFileSync(path, template.replace('@ALLOWED_SIGNERS@', signers), { mode: 0o755 })
}
