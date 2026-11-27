/**
 * Brain Agent's stable binding: `<state>/brain/agent-lane.json`. It names the lane by an opaque
 * ref that never changes and records the transcript the lane continues. Neither a process
 * handle, the folder, a title nor an emoji identifies the lane; this file does, and only the
 * Host writes it. A file that cannot be read as a binding fails closed instead of minting a
 * second identity.
 */
import { randomUUID } from 'node:crypto'
import { renameSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { isUuid } from '@phosphor/shared/control-api'

export interface BrainAgentBinding {
  /** Opaque and stable: what clients and the CLI name the lane by. */
  readonly ref: string
  /** The transcript the next turn continues; null before the lane's first turn. */
  readonly sessionFile: string | null
  /** The controller fence: only increases, across restarts, so an old reply never matches. */
  readonly fence: number
}

interface BindingFile extends BrainAgentBinding {
  readonly version: 1
}

export class BrainAgentBindingUnreadable extends Error {
  constructor() {
    super('Brain Agent’s lane binding cannot be read.')
  }
}

function parse(text: string): BrainAgentBinding {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new BrainAgentBindingUnreadable()
  }
  const file = value as Partial<BindingFile> | null
  if (
    typeof file !== 'object' ||
    file === null ||
    file.version !== 1 ||
    typeof file.ref !== 'string' ||
    !isUuid(file.ref) ||
    !(
      file.sessionFile === null ||
      (typeof file.sessionFile === 'string' && isAbsolute(file.sessionFile))
    ) ||
    typeof file.fence !== 'number' ||
    !Number.isSafeInteger(file.fence) ||
    file.fence < 1
  )
    throw new BrainAgentBindingUnreadable()
  return { ref: file.ref, sessionFile: file.sessionFile, fence: file.fence }
}

/** The binding at `path`, created on first read; writes are serialized and atomic. */
export function createBrainAgentBinding(path: string) {
  let current: BrainAgentBinding | undefined
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work)
    queue = next.catch(() => undefined)
    return next
  }
  const temporary = `${path}.${process.pid}.tmp`
  async function stage(binding: BrainAgentBinding): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const file: BindingFile = { version: 1, ...binding }
    await writeFile(temporary, JSON.stringify(file) + '\n', { mode: 0o600 })
  }
  async function save(binding: BrainAgentBinding): Promise<BrainAgentBinding> {
    await stage(binding)
    await rename(temporary, path)
    current = binding
    return binding
  }
  async function load(): Promise<BrainAgentBinding> {
    if (current) return current
    const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw new BrainAgentBindingUnreadable()
    })
    if (text === null) return save({ ref: randomUUID(), sessionFile: null, fence: 1 })
    current = parse(text)
    return current
  }
  return {
    read: () => serial(load),
    /** Records the transcript the lane continues; the ref stays. */
    bind: (sessionFile: string | null) =>
      serial(async () => {
        const binding = await load()
        return binding.sessionFile === sessionFile ? binding : save({ ...binding, sessionFile })
      }),
    /** Advances only if admitted at commit, then publishes the persisted fence synchronously. */
    advance: (admit: () => boolean, publish: (fence: number) => void) =>
      serial(async () => {
        const binding = await load()
        const next = { ...binding, fence: binding.fence + 1 }
        let committed = false
        try {
          await stage(next)
          if (!admit()) return false
          // No yield between authorization, the atomic replacement, and controller publication.
          renameSync(temporary, path)
          current = next
          committed = true
          publish(next.fence)
          return true
        } finally {
          if (!committed) await rm(temporary, { force: true }).catch(() => {})
        }
      }),
  }
}

export type BrainAgentBindingFile = ReturnType<typeof createBrainAgentBinding>
