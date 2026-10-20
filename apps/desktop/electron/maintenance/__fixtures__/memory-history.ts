import { vi } from 'vitest'

/** Disk-like state survives module reloads so restart tests exercise persistence. */
const memoryStores = vi.hoisted(() => new Map<string, Record<string, unknown>>())
vi.mock('electron-store', () => ({
  default: class {
    private data: Record<string, unknown>
    constructor(options: { name?: string; defaults: Record<string, unknown> }) {
      const name = options.name ?? 'config'
      if (!memoryStores.has(name)) memoryStores.set(name, structuredClone(options.defaults))
      this.data = memoryStores.get(name)!
    }
    get(key: string): unknown {
      return structuredClone(this.data[key])
    }
    set(key: string, value: unknown): void {
      this.data[key] = structuredClone(value)
    }
  },
}))
