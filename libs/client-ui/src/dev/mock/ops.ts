import type { IpcInvokeMap } from '@shared/ipc'

/** Harness agent control: every machine answers as one that does not serve catalog ops yet. */
export const OPS_MOCK: ReadonlySet<string> = new Set<keyof IpcInvokeMap>(['ops:run'])

export function mockOpsInvoke(): Promise<IpcInvokeMap['ops:run']['result']> {
  return Promise.resolve({
    status: 'denied',
    code: 'unsupported',
    text: 'This version of Phosphor does not run agent ops yet.',
  })
}
