import type { DatabaseSync } from 'node:sqlite'
import { HOST_LIMITS, type Receipt } from '@phosphor/shared/host-protocol'
import { canonicalJson, check, integer, JsonTooLarge, storedReceipt, uuid } from '../validation'
import { str, num, type Row } from './rows'
import type { RequestStart, StoreLimits } from './types'

export interface ReceiptStoreContext {
  db: DatabaseSync
  transaction: <T>(fn: () => T) => T
  clock: () => number
  limits: Readonly<StoreLimits>
  ttl: number
  isConnected: (clientId: string) => boolean
  logCorruptReceipt: (count: number) => void
}

const RECEIPT_EXPIRED = 'finished_at < ?'

function restoreConnectivity(value: unknown, isConnected: (clientId: string) => boolean): unknown {
  if (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    value.status === 'rejected' &&
    'control' in value
  ) {
    const control = value.control
    if (
      typeof control === 'object' &&
      control !== null &&
      'controller' in control &&
      control.controller !== null
    ) {
      const controller = control.controller
      check(
        typeof controller === 'object' &&
          'clientId' in controller &&
          typeof controller.clientId === 'string' &&
          !('connected' in controller),
      )
      value = {
        ...value,
        control: {
          ...control,
          controller: {
            ...controller,
            connected: isConnected(controller.clientId),
          },
        },
      }
    }
  }
  return value
}
function decodeReceipt(context: ReceiptStoreContext, row: Row): Receipt | null {
  try {
    if (row.status === 'started')
      return storedReceipt({ requestId: str(row, 'request_id'), status: 'pending' })
    const value = restoreConnectivity(JSON.parse(str(row, 'receipt_json')), context.isConnected)
    const receipt = storedReceipt(value)
    check(receipt.requestId === str(row, 'request_id') && receipt.status === str(row, 'status'))
    return receipt
  } catch {
    try {
      context.logCorruptReceipt(1)
    } catch {
      // A logger failure cannot turn corrupt state into a caller-visible error.
    }
    return null
  }
}
export function getReceipt(
  context: ReceiptStoreContext,
  requestId: string,
  clientId: string,
): Receipt | null {
  uuid(requestId)
  uuid(clientId)
  const row = context.db
    .prepare(
      `SELECT * FROM receipts WHERE request_id=? AND client_id=? AND (finished_at IS NULL OR NOT (${RECEIPT_EXPIRED}))`,
    )
    .get(requestId, clientId, context.clock() - context.ttl)
  return row ? decodeReceipt(context, row) : null
}
function serializeReceipt(receipt: Receipt): string {
  if (receipt.status === 'rejected' && receipt.control?.controller) {
    const { connected: _connected, ...controller } = receipt.control.controller
    return canonicalJson({ ...receipt, control: { ...receipt.control, controller } })
  }
  return canonicalJson(receipt)
}
export function beginRequest(
  context: ReceiptStoreContext,
  requestId: string,
  clientId: string,
  hash: string,
  laneId: string | null,
): RequestStart {
  uuid(requestId)
  uuid(clientId)
  check(/^[0-9a-f]{64}$/.test(hash))
  if (laneId !== null) uuid(laneId)
  return context.transaction(() => {
    const now = context.clock()
    prune(context, now)
    const row = context.db.prepare('SELECT * FROM receipts WHERE request_id=?').get(requestId)
    if (row) {
      const receipt = decodeReceipt(context, row)
      if (row.client_id !== clientId || row.op_hash !== hash || row.lane_id !== laneId)
        return { kind: 'conflict' }
      return {
        kind: 'existing',
        receipt: receipt ?? { requestId, status: 'unknown' },
      }
    }
    if (
      Number(
        context.db.prepare("SELECT count(*) AS count FROM receipts WHERE status='started'").get()
          ?.count,
      ) >= context.limits.receiptsKept
    )
      return { kind: 'busy' }
    context.db
      .prepare("INSERT INTO receipts VALUES (?,?,?,?,'started',NULL,?,NULL)")
      .run(requestId, clientId, hash, laneId, now)
    return { kind: 'new' }
  })
}
export function finishRequest(
  context: ReceiptStoreContext,
  requestId: string,
  receipt: Receipt,
): void {
  uuid(requestId)
  let value = storedReceipt(receipt)
  check(value.requestId === requestId && value.status !== 'pending')
  if (value.status === 'done' && value.data !== undefined) {
    try {
      canonicalJson(value.data, HOST_LIMITS.receiptDataBytes)
    } catch (error) {
      if (!(error instanceof JsonTooLarge)) throw error
      const { data: _data, ...withoutData } = value
      value = withoutData
    }
  }
  const json = serializeReceipt(value)
  check(Buffer.byteLength(json) <= HOST_LIMITS.receiptDataBytes + 8192)
  context.transaction(() => {
    const row = context.db.prepare('SELECT * FROM receipts WHERE request_id=?').get(requestId)
    check(row !== undefined)
    if (row.status !== 'started') {
      check(row.receipt_json === json)
      return
    }
    context.db
      .prepare('UPDATE receipts SET status=?,receipt_json=?,finished_at=? WHERE request_id=?')
      .run(value.status, json, Math.max(context.clock(), num(row, 'started_at')), requestId)
    pruneFinishedCount(context)
  })
}
export function markInterrupted(context: ReceiptStoreContext): void {
  context.transaction(() => {
    context.db
      .prepare(
        `UPDATE receipts SET status='unknown',receipt_json=json_object('requestId',request_id,'status','unknown'),finished_at=max(?,started_at) WHERE status='started'`,
      )
      .run(context.clock())
  })
}
function pruneFinishedCount(context: ReceiptStoreContext): void {
  context.db
    .prepare(
      `DELETE FROM receipts WHERE request_id IN (SELECT request_id FROM receipts WHERE finished_at IS NOT NULL ORDER BY finished_at DESC,request_id DESC LIMIT -1 OFFSET ?)`,
    )
    .run(context.limits.receiptsKept)
}
function prune(context: ReceiptStoreContext, now: number): void {
  context.db.prepare(`DELETE FROM receipts WHERE ${RECEIPT_EXPIRED}`).run(now - context.ttl)
  pruneFinishedCount(context)
}
export function pruneReceipts(context: ReceiptStoreContext, now: number): void {
  integer(now)
  context.transaction(() => prune(context, now))
}
