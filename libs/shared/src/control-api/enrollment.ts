/**
 * Enrollment bodies: a Host asks to enroll, polls for approval, and a person
 * looks up and approves its code. Parsers keep known fields only.
 */

import { normalizeUserCode } from './codes'
import {
  account,
  fail,
  isCount,
  isHostname,
  isIso,
  isRecord,
  isUuid,
  isVersion,
  normalizeLabel,
  ok,
  oneOf,
  type Parsed,
} from './fields'
import { parseMachineView } from './machines'
import { isKeyFingerprint, isPublicKey } from './signing'
import {
  ARCHES,
  PLATFORMS,
  type EnrollmentApproveRequest,
  type EnrollmentApproveResponse,
  type EnrollmentCreateRequest,
  type EnrollmentCreateResponse,
  type EnrollmentLookupRequest,
  type EnrollmentLookupResponse,
  type EnrollmentPollRequest,
  type EnrollmentPollResponse,
} from './types'

export function parseEnrollmentCreateRequest(value: unknown): Parsed<EnrollmentCreateRequest> {
  if (!isRecord(value)) return fail('body must be an object')
  if (!isPublicKey(value.publicKey)) return fail('publicKey')
  if (!isHostname(value.hostname)) return fail('hostname')
  if (!oneOf(PLATFORMS, value.platform)) return fail('platform')
  if (!oneOf(ARCHES, value.arch)) return fail('arch')
  if (!isVersion(value.hostVersion)) return fail('hostVersion')
  return ok({
    publicKey: value.publicKey,
    hostname: value.hostname,
    platform: value.platform,
    arch: value.arch,
    hostVersion: value.hostVersion,
  })
}

export function parseEnrollmentCreateResponse(value: unknown): Parsed<EnrollmentCreateResponse> {
  if (!isRecord(value)) return fail('body must be an object')
  if (!isUuid(value.enrollmentId)) return fail('enrollmentId')
  const userCode = normalizeUserCode(value.userCode)
  if (userCode === null || userCode !== value.userCode) return fail('userCode')
  if (!isKeyFingerprint(value.keyFingerprint)) return fail('keyFingerprint')
  if (!isIso(value.expiresAt)) return fail('expiresAt')
  if (!isCount(value.pollIntervalSec, 60) || value.pollIntervalSec < 1)
    return fail('pollIntervalSec')
  return ok({
    enrollmentId: value.enrollmentId,
    userCode,
    keyFingerprint: value.keyFingerprint,
    expiresAt: value.expiresAt,
    pollIntervalSec: value.pollIntervalSec,
  })
}

export function parseEnrollmentPollRequest(value: unknown): Parsed<EnrollmentPollRequest> {
  if (!isRecord(value) || !isUuid(value.enrollmentId)) return fail('enrollmentId')
  return ok({ enrollmentId: value.enrollmentId })
}

export function parseEnrollmentPollResponse(value: unknown): Parsed<EnrollmentPollResponse> {
  if (!isRecord(value)) return fail('body must be an object')
  if (value.status === 'pending' || value.status === 'expired') return ok({ status: value.status })
  if (value.status !== 'approved') return fail('status')
  const label = normalizeLabel(value.label)
  const owner = account(value.owner)
  if (!isUuid(value.hostId)) return fail('hostId')
  if (label === null || label !== value.label) return fail('label')
  if (!owner) return fail('owner')
  return ok({ status: 'approved', hostId: value.hostId, label, owner })
}

export function parseEnrollmentLookupRequest(value: unknown): Parsed<EnrollmentLookupRequest> {
  const code = isRecord(value) ? normalizeUserCode(value.userCode) : null
  return code ? ok({ userCode: code }) : fail('userCode')
}

export function parseEnrollmentLookupResponse(value: unknown): Parsed<EnrollmentLookupResponse> {
  if (!isRecord(value)) return fail('body must be an object')
  if (!isHostname(value.hostname)) return fail('hostname')
  if (!oneOf(PLATFORMS, value.platform)) return fail('platform')
  if (!oneOf(ARCHES, value.arch)) return fail('arch')
  if (!isVersion(value.hostVersion)) return fail('hostVersion')
  if (!isKeyFingerprint(value.keyFingerprint)) return fail('keyFingerprint')
  if (!isIso(value.expiresAt)) return fail('expiresAt')
  return ok({
    hostname: value.hostname,
    platform: value.platform,
    arch: value.arch,
    hostVersion: value.hostVersion,
    keyFingerprint: value.keyFingerprint,
    expiresAt: value.expiresAt,
  })
}

export function parseEnrollmentApproveRequest(value: unknown): Parsed<EnrollmentApproveRequest> {
  if (!isRecord(value)) return fail('body must be an object')
  const code = normalizeUserCode(value.userCode)
  const label = normalizeLabel(value.label)
  if (!code) return fail('userCode')
  if (label === null) return fail('label')
  return ok({ userCode: code, label })
}

export function parseEnrollmentApproveResponse(value: unknown): Parsed<EnrollmentApproveResponse> {
  if (!isRecord(value)) return fail('body must be an object')
  const machine = parseMachineView(value.machine)
  return machine.ok ? ok({ machine: machine.value }) : fail(`machine: ${machine.reason}`)
}
