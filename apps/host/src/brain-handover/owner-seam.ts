/**
 * The handover handlers on `run`'s owner socket. The native Brain runtime supplies what only it
 * knows: whether this target can run the reader, the pinned embedding model, the model probe and
 * the reserved lane's transcript binding. Until it does, `status` says the Host cannot take a
 * Brain and Desktop keeps its own.
 */
import { hostStateDirectory } from '@phosphor/shared/host-local'
import {
  readLocalBrainSelection,
  selectLocalBrainOwner,
} from '@phosphor/session-runtime/brain/local-owner'
import { OwnerCallRefused } from '../owner/adapter'
import type { RunContext } from '../commands/run'
import type { OwnerHandlers } from '../owner/adapter'
import type { OwnerSeam } from '../owner/socket'
import { pinBrainCompatibility } from '../update/brain-compatibility'
import { targetOccupied } from './layout'
import { createBrainHandoverHandlers, type BrainHandoverPorts } from './handlers'

export type BrainHandoverNativePorts = Partial<
  Pick<
    BrainHandoverPorts,
    'readerReadiness' | 'importAgentTranscripts' | 'embeddingModel' | 'probeModel'
  >
>

/**
 * `native` is read on every call: the socket binds before the lanes start, and the Brain runtime
 * that supplies these ports (`createBrainHandoverNativePorts`) exists only once they do.
 */
export function brainHandoverOwnerHandlers(
  context: RunContext,
  native: () => BrainHandoverNativePorts | undefined = () => undefined,
): (seam: OwnerSeam) => OwnerHandlers {
  return ({ store }) => {
    const stateDir = hostStateDirectory(context.env, context.home)
    const handlers = createBrainHandoverHandlers({
      stateDir,
      uid: context.uid,
      now: context.now,
      laneForSessionFile: (path) => store.sessionLane(path) !== null,
      readerReadiness: () =>
        (native()?.readerReadiness ?? (() => Promise.resolve('unavailable' as const)))(),
      get importAgentTranscripts() {
        return native()?.importAgentTranscripts
      },
      get embeddingModel() {
        return native()?.embeddingModel
      },
      get probeModel() {
        return native()?.probeModel
      },
      log: (event, fields = {}) => context.log?.('host', event, fields),
    })
    const pin = () => {
      if (!native())
        throw new OwnerCallRefused('unsupported', 'This Host does not support Brain handover.')
      pinBrainCompatibility({ home: context.home, uid: context.uid })
    }
    return {
      ...handlers,
      'owner.brainHandover.pin': async () => {
        pin()
        return { pinned: true as const }
      },
      'owner.brainHandover.status': async (params) => {
        const result = await handlers['owner.brainHandover.status'](params)
        return { ...result, support: { ...result.support, ownerSelection: 1 } }
      },
      // Even older Desktop versions must not observe a verified move on an unpinned install.
      'owner.brainHandover.verify': async (params) => {
        pin()
        return handlers['owner.brainHandover.verify'](params)
      },
      'owner.brainHandover.commit': async (params) => {
        pin()
        return handlers['owner.brainHandover.commit'](params)
      },
      'owner.brainHandover.begin': async (params) => {
        // Reserve against a fresh native grant before begin awaits reader preflight. Older
        // Desktop builds know the move protocol but do not make this selection themselves.
        if (
          (readLocalBrainSelection(stateDir) === 'unset' && targetOccupied(stateDir)) ||
          !selectLocalBrainOwner(stateDir, 'desktop')
        )
          throw new OwnerCallRefused('forbidden', 'This Mac cannot move a Brain to this service.')
        return handlers['owner.brainHandover.begin'](params)
      },
    }
  }
}
