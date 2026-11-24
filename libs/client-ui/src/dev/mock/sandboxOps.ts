import type { OpsRunRequest, OpsRunResult } from '@phosphor/shared/host-protocol-ops'

/** In-memory sandbox rows per mock Host. Rename/delete return a job like the daemon. */
const rows = new Map<string, Map<string, string>>()
const jobs = new Map<string, string>()
export function mockSandboxOp(host: string, req: OpsRunRequest): OpsRunResult | undefined {
  if (!req.op.startsWith('sandbox.') && req.op !== 'job.status') return
  const items = rows.get(host) ?? new Map<string, string>()
  rows.set(host, items)
  const { path, name, jobId } = req.args
  const ok = (data: unknown): OpsRunResult => ({ status: 'ok', applies: 'now', text: 'Done', data })
  const denied: OpsRunResult = {
    status: 'denied',
    code: 'bad-request',
    text: 'Invalid sandbox operation.',
  }
  if (req.op === 'job.status')
    return typeof jobId === 'string' && jobs.get(jobId) === host ? ok({ state: 'done' }) : denied
  if (req.op === 'sandbox.list') return ok([...items].map(([path, name]) => ({ path, name })))
  if (req.op !== 'sandbox.create' && (typeof path !== 'string' || !items.has(path))) return denied
  if (req.op !== 'sandbox.delete') {
    if (typeof name !== 'string' || !name || items.has(`/sandboxes/${name}`)) return denied
    items.set(`/sandboxes/${name}`, name)
    if (req.op === 'sandbox.create') return ok({ path: `/sandboxes/${name}` })
  }
  items.delete(String(path))
  const id = crypto.randomUUID()
  jobs.set(id, host)
  return ok({ jobId: id })
}
