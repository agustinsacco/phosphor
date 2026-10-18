import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { HostFrame } from '@phosphor/shared/host-protocol'
import type { HostCapability } from '@phosphor/shared/remote-host'
import { ARTIFACT_LIMITS, parseArtifactParams } from '@phosphor/shared/host-protocol-artifacts'
import {
  createArtifactHost,
  remoteArtifactListings,
  remoteArtifactRead,
  remoteSessionArtifacts,
  type ArtifactHost,
} from './artifacts'
const laneId = '11111111-1111-4111-8111-111111111111'
const item = {
  laneId,
  slug: 'guide',
  title: 'Guide',
  type: 'html',
  versions: [{ version: 1, title: 'Guide', bytes: 2, createdAt: 0 }],
}
const host: ArtifactHost = {
  hostId: '22222222-2222-4222-8222-222222222222',
  label: 'bee',
  call: vi.fn(async (method) =>
    method === 'artifacts.list' ? [item] : { version: 1, content: 'é' },
  ),
}
describe('Desktop remote artifacts', () => {
  it('maps only opaque lane/slug keys and machine tags, then reads versions', async () => {
    const rows = await remoteArtifactListings([host])
    expect(rows[0]).toMatchObject({
      machine: 'bee',
      key: `host:${host.hostId}/lane:${laneId}/artifact:guide`,
      workspaceExists: false,
    })
    const read = await remoteArtifactRead(rows[0]?.key ?? '', [host])
    expect(read?.artifact.versions[0]?.content).toBe('é')
  })
  it('fails closed on unsolicited paths, mismatched lane/version and declared size', async () => {
    for (const data of [
      [{ ...item, sessionFile: '/private' }],
      [{ ...item, laneId: '33333333-3333-4333-8333-333333333333' }],
    ]) {
      await expect(
        remoteSessionArtifacts({ laneId, workspacePath: '', call: async () => data }),
      ).rejects.toThrow()
    }
    for (const read of [
      { version: 2, content: 'é' },
      { version: 1, content: 'x' },
    ]) {
      await expect(
        remoteSessionArtifacts({
          laneId,
          workspacePath: '',
          call: async (_, method) => (method === 'artifacts.list' ? [item] : read),
        }),
      ).rejects.toThrow()
    }
  })
  it('checks the total budget before content requests at and above 8 MiB', async () => {
    const versions = Array.from({ length: 4 }, (_, i) => ({
      version: i + 1,
      title: '',
      bytes: ARTIFACT_LIMITS.contentBytes,
      createdAt: 0,
    }))
    const call = vi.fn(async (_cap: HostCapability, method: string, params: unknown) =>
      method === 'artifacts.list'
        ? [{ ...item, versions }]
        : {
            version: parseArtifactParams(method, params)?.version,
            content: 'x'.repeat(ARTIFACT_LIMITS.contentBytes),
          },
    )
    await expect(remoteSessionArtifacts({ laneId, workspacePath: '', call })).resolves.toHaveLength(
      1,
    )
    versions.push({ version: 5, title: '', bytes: 1, createdAt: 0 })
    call.mockClear()
    await expect(remoteSessionArtifacts({ laneId, workspacePath: '', call })).rejects.toThrow()
    expect(call).toHaveBeenCalledTimes(1)
  })
})

it('library connection adapter validates requests, sanitizes failures and rejects stale replies', async () => {
  let capabilities: HostCapability[] = ['artifacts.read']
  let connected = true
  const call = vi.fn(async (): Promise<Extract<HostFrame, { type: 'result' }>> => ({
    type: 'result',
    id: randomUUID(),
    ok: true,
    data: [],
  }))
  const connection = { snapshot: () => ({ state: 'ready', capabilities }), call }
  const host = createArtifactHost('id', 'bee', connection, () =>
    connected ? connection : undefined,
  )
  await expect(host.call('artifacts.list', { path: '/secret' })).rejects.toThrow()
  expect(call).not.toHaveBeenCalled()
  capabilities = []
  await expect(host.call('artifacts.list', {})).rejects.toThrow()
  expect(call).not.toHaveBeenCalled()
  capabilities = ['artifacts.read']
  call.mockImplementation(async () => {
    throw new Error('/secret token')
  })
  await expect(host.call('artifacts.list', {})).rejects.toThrow(
    'Not available on remote lanes yet.',
  )
  call.mockImplementation(async () => {
    capabilities = []
    return { type: 'result', id: randomUUID(), ok: true, data: [] }
  })
  await expect(host.call('artifacts.list', {})).rejects.toThrow()
  capabilities = ['artifacts.read']
  call.mockImplementation(async () => {
    connected = false
    return { type: 'result', id: randomUUID(), ok: true, data: [] }
  })
  await expect(host.call('artifacts.list', {})).rejects.toThrow()
})

it('bounds version requests even when contents are empty', async () => {
  const versions = Array.from({ length: ARTIFACT_LIMITS.callVersions }, (_, i) => ({
    version: i + 1,
    title: '',
    createdAt: 0,
    bytes: 0,
  }))
  const items = [{ ...item, versions }]
  const call = vi.fn(async (_cap: HostCapability, method: string, params: unknown) =>
    method === 'artifacts.list'
      ? items
      : { version: parseArtifactParams(method, params)?.version, content: '' },
  )
  await expect(remoteSessionArtifacts({ laneId, workspacePath: '', call })).resolves.toHaveLength(1)
  items.push({
    ...item,
    slug: 'extra',
    versions: [{ version: 1, title: '', createdAt: 0, bytes: 0 }],
  })
  call.mockClear()
  await expect(remoteSessionArtifacts({ laneId, workspacePath: '', call })).rejects.toThrow()
  expect(call).toHaveBeenCalledTimes(1)
})

it('library omits failing machines but retains healthy machines', async () => {
  const failed: ArtifactHost = {
    ...host,
    hostId: 'failed',
    call: async () => {
      throw new Error('unavailable')
    },
  }
  const invalid: ArtifactHost = {
    ...host,
    hostId: 'invalid',
    call: async () => [{ path: '/private' }],
  }
  const rows = await remoteArtifactListings([failed, host, invalid])
  expect(rows).toHaveLength(1)
  expect(rows[0]?.machine).toBe('bee')
})

it('fences an artifact read across a reconnect on the same connection object', async () => {
  let token = 'first'
  const connection = {
    snapshot: () => ({
      state: 'ready',
      capabilities: ['artifacts.read' as const],
      connectionToken: token,
    }),
    call: async () => {
      token = 'second'
      return { type: 'result' as const, id: randomUUID(), ok: true as const, data: [item] }
    },
  }
  const bridge = createArtifactHost(host.hostId, 'Fixture', connection, () => connection)
  await expect(bridge.call('artifacts.list', {})).rejects.toThrow()
})
