import type { HostCapability } from '../remote-host'
import { authScenarios as auth } from './conformance/auth'
import { describeConformance, type ConformanceScenario } from './conformance/context'
import { controlScenarios as control } from './conformance/control'
import { limitScenarios as limits } from './conformance/limits'
import { receiptScenarios as receipts } from './conformance/receipts'
import { streamScenarios as streams } from './conformance/streams'
import type { HostConformanceFactory } from './conformance/types'

export type {
  ConformanceConnection,
  ConformanceOptions,
  HostConformanceFactory,
  HostConformanceHarness,
} from './conformance/types'

/** Registration order and expanded titles are the contract both Hosts are measured by. */
const hostConformanceScenarios: readonly ConformanceScenario[] = [
  auth.authFirstFrame,
  auth.wrongGrantClaim,
  auth.enrolledHostProof,
  auth.foreignHostHello,
  auth.revokedGrants,
  limits.malformedInput,
  streams.lanesAndAttention,
  streams.orderedReplay,
  receipts.deduplication,
  receipts.resendOnNewSocket,
  receipts.answerDeadline,
  receipts.unknownReceipts,
  receipts.interruptedCommand,
  control.capabilityAndCalls,
  limits.inFlightCalls,
  control.takeover,
  control.dialogAnswer,
  streams.uiHydration,
  limits.subscriptionAndCommandCaps,
  control.stopAndResume,
  limits.slowViewer,
  control.controllerReconnect,
  receipts.terminalPerSocket,
  receipts.receiptCaps,
  receipts.startedReceiptTtl,
  auth.readAuthority,
  streams.boundedReplay,
  streams.oversizeEvent,
  streams.bufferedReplayAfterOversize,
  limits.connectionsPerClient,
  limits.oversizeSubscription,
]

/** The same scenarios run against the model and the real Host adapter. No fake internals. */
export function defineHostConformance(
  name: string,
  factory: HostConformanceFactory,
  options: { capabilities?: readonly HostCapability[] } = {},
) {
  const announced = options.capabilities ?? ['sessions.read', 'sessions.control']
  describeConformance(name, factory, announced, hostConformanceScenarios)
}
