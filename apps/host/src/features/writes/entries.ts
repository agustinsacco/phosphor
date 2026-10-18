import { mkdir, open } from 'node:fs/promises'
import { relative, sep } from 'node:path'
import type { FileWriteOp } from '@phosphor/shared/host-protocol-writes'
import {
  renameNoReplace,
  transferEntry as transfer,
} from '@phosphor/session-runtime/files/mutations'
import { inside } from '../files'
import { mutationPath, WriteFailure } from './guards'

export async function createEntry(
  root: string,
  op: Extract<FileWriteOp, { type: 'files.create' }>,
): Promise<void> {
  const target = await mutationPath(root, op.path, true)
  if (op.kind === 'directory') await mkdir(target)
  else {
    const file = await open(target, 'wx', 0o600)
    await file.close()
  }
}

export async function renameEntry(
  root: string,
  op: Extract<FileWriteOp, { type: 'files.rename' }>,
): Promise<void> {
  const from = await mutationPath(root, op.from)
  const to = await mutationPath(root, op.to, true)
  if (inside(from, to)) throw new WriteFailure('bad-request')
  await mutationPath(root, op.from)
  await renameNoReplace(from, to)
}

export async function transferEntry(
  root: string,
  op: Extract<FileWriteOp, { type: 'files.transfer' }>,
) {
  const source = await mutationPath(root, op.source)
  const directory = op.directory === '.' ? root : await mutationPath(root, op.directory)
  let entries = 0
  const path = await transfer(root, source, directory, op.mode, async (path, missing) => {
    if (++entries > 40000 || !inside(root, path)) throw new WriteFailure('bad-request')
    if (path !== root) await mutationPath(root, relative(root, path).split(sep).join('/'), missing)
  })
  return { path: relative(root, path).split(sep).join('/') }
}
