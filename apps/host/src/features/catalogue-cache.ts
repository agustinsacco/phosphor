import { statSync, lstatSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { FeatureFailure } from './machine'
import type { HostInspection } from '../commands/doctor'

/** Include file replacement as well as an edit in place. Never read auth bytes. */
export function catalogueIdentity(dir: string, pi: HostInspection['pi']) {
  const files = ['settings.json', 'models.json', 'auth.json', 'oauth.json'].map((name) => {
    const file = lstatSync(join(dir, name), { throwIfNoEntry: false })
    return file && [file.ino, file.mtimeMs, file.size]
  })
  const launchFiles =
    pi &&
    [pi.launch.binaryPath, ...pi.launch.prefixArgs.filter(isAbsolute)].map((path) => {
      const file = statSync(path, { throwIfNoEntry: false })
      return file && [file.ino, file.mtimeMs, file.size]
    })
  return [pi?.launch, launchFiles, dir, files]
}

interface Entry<T> {
  value?: T
  refresh?: Promise<T>
  next: number
}
/** Last good answer per admitted identity. A failed refresh cannot evict a good answer. */
export class CatalogueCache<T> {
  private entries = new Map<string, Entry<T>>()
  get(key: string, read: () => Promise<T>): Promise<T> {
    const entry = this.entries.get(key) ?? { next: 0 }
    if (!this.entries.has(key)) {
      if (this.entries.size >= 64) {
        const idle = [...this.entries].find(([, candidate]) => !candidate.refresh)
        if (!idle) return Promise.reject(new FeatureFailure('internal'))
        this.entries.delete(idle[0])
      }
      this.entries.set(key, entry)
    }
    if (!entry.refresh && Date.now() >= entry.next) {
      entry.refresh = read()
        .then((value) => {
          entry.value = value
          entry.next = Date.now() + 60_000
          return value
        })
        .finally(() => {
          delete entry.refresh
        })
      void entry.refresh.catch(() => {
        if (entry.value !== undefined) entry.next = Date.now() + 5000
      })
    }
    return entry.value !== undefined ? Promise.resolve(entry.value) : entry.refresh!
  }
}
