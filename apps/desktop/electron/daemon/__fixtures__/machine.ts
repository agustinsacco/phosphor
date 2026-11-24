import { homedir, tmpdir } from 'node:os'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  localReleaseMirror,
  probeNode,
} from '@phosphor/session-runtime/host-install/__fixtures__/local-release'
import { fakeCipher } from '../../account/__fixtures__/fakes'
import { loadOwnerKey } from '../owner-key'
import type { DaemonInstallPorts } from '../install'
import { DAEMON_RELEASE_KEY_ENV, DAEMON_ROOT_ENV, daemonRoots, type DaemonRoots } from '../roots'

export const MACHINE_ID = '00000000-0000-4000-8000-0000000000aa'

/** A fake Host program: records its argv and env under its HOME, answers like `setup --local --json`. */
export const fakeSetup = (exitCode = 0, notes: string[] = []): string =>
  `#!/bin/sh\nprintf '%s\\n' "$@" > "$HOME/setup-args"\nenv > "$HOME/setup-env"\necho '${JSON.stringify({ exitCode, notes, ...(exitCode === 0 && { machineId: MACHINE_ID }) })}'\nexit ${exitCode}\n`

/** A scratch machine: release folder, roots from the dev hook, and ports with a fake keychain. */
export function scratchMachine() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'daemon-install-')))
  const mirror = localReleaseMirror(join(root, 'release'))
  const result = daemonRoots({
    isPackaged: false,
    env: {
      [DAEMON_ROOT_ENV]: join(root, 'machine'),
      [DAEMON_RELEASE_KEY_ENV]: mirror.keys[0]!.publicKey,
      ...mirror.env,
    },
    home: homedir(),
    platform: 'darwin',
    arch: 'arm64',
  })
  if (!result.on) throw new Error(result.reason)
  const roots: DaemonRoots = result.roots
  if (!roots.home.startsWith(`${root}/`)) throw new Error('scratch roots escaped')
  mkdirSync(roots.home, { recursive: true, mode: 0o700 })
  mkdirSync(join(root, 'user-data'), { mode: 0o700 })
  const { cipher } = fakeCipher({ ok: true, kind: 'keychain' })
  const ports: DaemonInstallPorts = {
    roots,
    ownerKey: () => loadOwnerKey({ dir: join(root, 'user-data/daemon'), cipher }),
    findPi: () => Promise.resolve('/opt/pi/bin/pi'),
    shellPath: () => Promise.resolve('/opt/pi/bin:/usr/bin:/bin'),
    baseEnv: { LANG: 'C' },
    inspect: { readLock: () => Promise.resolve(null) },
  }
  /** A release install of `version` left by install.sh, answering `version --json` with `features`. */
  const installed = (version: string, features: string[]) => {
    const folder = join(roots.lib, 'versions', version)
    for (const [name, text] of [
      ['VERSION', `${version}\n`],
      ['bin/phosphor', fakeSetup()],
      ['node/bin/node', probeNode(version, features)],
      ['lib/phosphor.mjs', ''],
    ] as const) {
      mkdirSync(join(folder, name, '..'), { recursive: true })
      writeFileSync(join(folder, name), text, { mode: 0o755 })
    }
    symlinkSync(`versions/${version}`, join(roots.lib, 'current'))
  }
  return {
    root,
    mirror,
    roots,
    ports,
    installed,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}
