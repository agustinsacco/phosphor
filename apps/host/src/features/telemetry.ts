/**
 * The Host's own resource sample, as a feature of its own.
 *
 * It is its own feature rather than one more method on the skills catalogue
 * because the two share nothing: skills read files under pi's folders, this asks
 * the kernel about the machine, and a client polls it every couple of seconds
 * while a doctor inspection can hold the probe slot for 20 s. Dispatched ahead of
 * the catalogue, a slow inspection never delays a poll.
 *
 * It rides `skills.read`, the capability the merged contract shipped on. The read
 * is new authority and would rather have its own, but protocol v1 cannot announce
 * a capability name an older client has not heard: `capabilities()` in
 * `libs/shared/src/host-protocol/host-ready.ts` refuses a `ready` frame carrying
 * one, which would lock an older Desktop out of its own service, and Control
 * cannot issue a claim outside its frozen list. A dedicated `machine.telemetry`
 * capability is a protocol revision, not a telemetry feature.
 */
import { parseMachineParams } from '@phosphor/shared/host-protocol-machine'
import { FeatureFailure, featureError } from './machine'
import type { FeatureContext, HostFeature } from './feature'
import { sampleTelemetry } from '../machine/telemetry'

export function createTelemetryFeature(context: FeatureContext): HostFeature {
  return {
    capability: 'skills.read',
    methods: ['machine.telemetry'],
    async call(method, params) {
      if (method !== 'machine.telemetry') return featureError(new FeatureFailure('unsupported'))
      if (!parseMachineParams(method, params))
        return featureError(new FeatureFailure('bad-request'))
      // No pi, no repository, no inspection: the kernel answers for the machine,
      // and `sampleTelemetry` reports what it could not read rather than throwing.
      return { ok: true, data: await sampleTelemetry({ home: context.home }) }
    },
  }
}
