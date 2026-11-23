import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { HOST_SIDECARS } from '@phosphor/shared/host-local'
import { AGENT_POLICY_DEFAULT, parseAgentPolicy, type AgentPolicy } from '@phosphor/shared/ops'
import { stricterPolicy } from '@phosphor/session-runtime/ops/policy'
import type { PolicyStore } from '@phosphor/session-runtime/ops/types'
import { readSidecar, writeSidecar } from '../config/sidecar'

export interface PolicyFilePorts {
  /** The Host state folder; the policy is `<state>/agent-policy.json`. */
  readonly directory: string
  readonly uid: number | undefined
  /** `state.sqlite`, holding `agent_policy_meta`. */
  readonly db: DatabaseSync
  readonly now: () => number
  readonly log?: (event: string, fields?: Record<string, unknown>) => void
}

const KNOWN = ['version', 'agentControl', 'machineOps', 'tiers', 'ops', 'limits'] as const

/** The digest of a policy's meaning: the parser's normal form, so unknown keys never count. */
function policyDigest(policy: AgentPolicy): string {
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex')
}

interface PolicyMeta {
  readonly written: string
  readonly snapshot: AgentPolicy
}

function readMeta(db: DatabaseSync): PolicyMeta | null {
  const row = db.prepare('SELECT written_sha256, snapshot FROM agent_policy_meta WHERE id=1').get()
  if (!row || typeof row.written_sha256 !== 'string' || typeof row.snapshot !== 'string')
    return null
  let snapshot: AgentPolicy | null = null
  try {
    snapshot = parseAgentPolicy(JSON.parse(row.snapshot))
  } catch {
    snapshot = null
  }
  return snapshot ? { written: row.written_sha256, snapshot } : null
}

/**
 * The daemon's agent policy: `<state>/agent-policy.json`, an owner-only file
 * the user may edit, with the digest and snapshot of the daemon's own last
 * write in `agent_policy_meta`. When the file no longer matches that write
 * (edited, replaced, removed or unreadable), the daemon enforces the stricter
 * of the file and its snapshot, key by key, and reports `changedOutside` so
 * Settings shows the banner. A first run with no file is the default policy.
 */
export function createPolicyFile(ports: PolicyFilePorts): PolicyStore {
  const { directory, uid, db } = ports
  return {
    async read() {
      const meta = readMeta(db)
      const file = readSidecar(directory, HOST_SIDECARS.agentPolicy, parseAgentPolicy, { uid })
      if (!meta) {
        if (file.state === 'missing') return { policy: AGENT_POLICY_DEFAULT, changedOutside: false }
        // A file the daemon never wrote can only tighten the default.
        const found = file.state === 'ok' ? file.value : AGENT_POLICY_DEFAULT
        return { policy: stricterPolicy(found, AGENT_POLICY_DEFAULT), changedOutside: true }
      }
      if (file.state === 'ok' && policyDigest(file.value) === meta.written)
        return { policy: file.value, changedOutside: false }
      ports.log?.('ops.policy_changed_outside', { file: file.state })
      // A removed file reads as the default; an unreadable one cannot relax anything.
      const found =
        file.state === 'ok'
          ? file.value
          : file.state === 'missing'
            ? AGENT_POLICY_DEFAULT
            : meta.snapshot
      return { policy: stricterPolicy(found, meta.snapshot), changedOutside: true }
    },
    async write(policy) {
      const normal = parseAgentPolicy(policy)
      if (!normal) throw new Error('Invalid agent policy.')
      writeSidecar(directory, HOST_SIDECARS.agentPolicy, { ...normal }, { uid, known: KNOWN })
      db.prepare(
        `INSERT INTO agent_policy_meta (id, written_sha256, snapshot, written_at) VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET written_sha256=excluded.written_sha256,
           snapshot=excluded.snapshot, written_at=excluded.written_at`,
      ).run(policyDigest(normal), JSON.stringify(normal), ports.now())
    },
  }
}
