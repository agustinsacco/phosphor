/** Command ops: the lane and pi ops parsed here, and the families other modules own. */
import { parseAttachmentOp } from '../host-protocol-attachments'
import { parseProviderLoginOp } from '../host-protocol-providers'
import { parseMachineTask, isMachineAccountId } from '../machine-settings'
import { parseLaneMarksOp } from '../host-protocol-lane-marks'
import { parseDeleteLaneOp, parseRepositoryOp } from '../host-protocol-repositories'
import { parseRoutineOp, ROUTINE_OPS } from '../host-protocol-routines'
import { parseTerminalOp } from '../host-protocol-terminals'
import { parseFileWriteOp } from '../host-protocol-writes'
import { parseExtensionUiResponse, parsePromptImages } from './client-content'
import { HOST_LIMITS } from './constants'
import { LANE_PI_OPS, type LaneOp } from './operations'
import { hex, integer, isLaneBranchName, label, member, record, text } from './primitives'

type OpFields = Record<string, unknown>

const thinking = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * An invalid op whose type is listed here is refused as bad-request; any other
 * type string as unsupported. File and attachment ops are not listed, so an
 * invalid one of those is refused as unsupported.
 */
export const BAD_REQUEST_OP_TYPES = [
  ...ROUTINE_OPS,
  ...LANE_PI_OPS,
  'extension_ui_response',
  'provider.login',
  'machine.task',
  'claude.account',
  'terminal.create',
  'terminal.resize',
  'terminal.kill',
  'host.repositories.add',
  'host.repositories.remove',
  'host.repositories.createFolder',
  'host.repositories.order',
  'lane.delete',
  'lane.create',
  'lane.resume',
  'lane.stop',
  'lane.markRead',
  'lane.marks',
  'control.take',
  'control.release',
] as const

function messageOp(v: OpFields, type: 'prompt' | 'steer' | 'follow_up'): LaneOp | null {
  if (!text(v.message, HOST_LIMITS.inboundFrameBytes)) return null
  const img = v.images === undefined ? undefined : parsePromptImages(v.images)
  if (img === null) return null
  if (type === 'prompt') {
    if (v.streamingBehavior !== undefined && !member(v.streamingBehavior, ['steer', 'followUp']))
      return null
    return {
      type,
      message: v.message,
      ...(img ? { images: img } : {}),
      ...(v.streamingBehavior !== undefined ? { streamingBehavior: v.streamingBehavior } : {}),
    }
  }
  return { type, message: v.message, ...(img ? { images: img } : {}) }
}

function createOp(v: OpFields): LaneOp | null {
  if (
    !hex(v.repositoryId) ||
    (v.worktree !== null &&
      (!record(v.worktree) ||
        !isLaneBranchName(v.worktree.branch) ||
        (v.worktree.fresh !== undefined && v.worktree.fresh !== true))) ||
    (v.name !== undefined && !label(v.name)) ||
    (v.provider !== undefined && !text(v.provider, 200)) ||
    (v.model !== undefined && !text(v.model, 200)) ||
    (v.thinkingLevel !== undefined && !member(v.thinkingLevel, thinking))
  )
    return null
  return {
    type: 'lane.create',
    repositoryId: v.repositoryId,
    worktree:
      record(v.worktree) && isLaneBranchName(v.worktree.branch)
        ? {
            branch: v.worktree.branch,
            ...(v.worktree.fresh === true ? { fresh: true as const } : {}),
          }
        : null,
    ...(v.name !== undefined ? { name: v.name } : {}),
    ...(v.provider !== undefined ? { provider: v.provider } : {}),
    ...(v.model !== undefined ? { model: v.model } : {}),
    ...(v.thinkingLevel !== undefined ? { thinkingLevel: v.thinkingLevel } : {}),
  }
}

function coreOp(v: OpFields): LaneOp | null {
  switch (v.type) {
    case 'prompt':
    case 'steer':
    case 'follow_up':
      return messageOp(v, v.type)
    case 'abort':
    case 'abort_retry':
    case 'lane.resume':
    case 'lane.stop':
    case 'control.take':
    case 'control.release':
      return { type: v.type }
    case 'set_model':
      return text(v.provider, 200) && text(v.modelId, 200)
        ? { type: v.type, provider: v.provider, modelId: v.modelId }
        : null
    case 'set_thinking_level':
      return member(v.level, thinking) ? { type: v.type, level: v.level } : null
    case 'compact':
      return v.customInstructions === undefined
        ? { type: v.type }
        : text(v.customInstructions, HOST_LIMITS.inboundFrameBytes)
          ? { type: v.type, customInstructions: v.customInstructions }
          : null
    case 'set_session_name':
      return label(v.name) ? { type: v.type, name: v.name } : null
    case 'extension_ui_response': {
      const r = parseExtensionUiResponse(v.response)
      return r ? { type: v.type, response: r } : null
    }
    case 'lane.markRead':
      return integer(v.upTo) ? { type: v.type, upTo: v.upTo } : null
    case 'lane.create':
      return createOp(v)
    case 'claude.account':
      return Object.keys(v).every((key) => ['type', 'accountId'].includes(key)) &&
        isMachineAccountId(v.accountId)
        ? { type: 'claude.account', accountId: v.accountId }
        : null
    default:
      return null
  }
}

/** The module that parses `type`'s op family, or undefined for the core ops above. */
function familyParser(type: unknown): ((v: OpFields) => LaneOp | null) | undefined {
  if (type === 'lane.delete') return parseDeleteLaneOp
  if (type === 'lane.marks') return parseLaneMarksOp
  if (typeof type === 'string' && type.startsWith('host.repositories.')) return parseRepositoryOp
  if (type === 'provider.login') return parseProviderLoginOp
  if (type === 'machine.task') return parseMachineTask
  if (typeof type === 'string' && type.startsWith('terminal.')) return parseTerminalOp
  if (typeof type === 'string' && type.startsWith('routine.')) return parseRoutineOp
  return undefined
}

/** Attachment and file ops are tried first, before the record check, as they always were. */
export function parseLaneOp(v: unknown): LaneOp | null {
  const attachment = parseAttachmentOp(v)
  if (attachment) return attachment
  const write = parseFileWriteOp(v)
  if (write) return write
  if (!record(v)) return null
  const family = familyParser(v.type)
  return family ? family(v) : coreOp(v)
}
