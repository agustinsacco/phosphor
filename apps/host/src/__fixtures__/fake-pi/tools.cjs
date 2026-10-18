'use strict'
const { randomUUID } = require('node:crypto')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

function createToolState(messages) {
  return {
    artifactVersion: messages.reduce(
      (version, message) =>
        message.role === 'toolResult' && message.details?.id === 'host-card'
          ? Math.max(version, message.details.version ?? 0)
          : version,
      0,
    ),
  }
}

function laneMarker(cwd) {
  try {
    if (readFileSync(join(cwd, 'remote.txt'), 'utf8').includes('HOST_B_ONLY')) return 'HOST_B_ONLY'
  } catch {}
  return 'HOST_A_ONLY'
}
function artifact(state, { cwd, out, persist, text }) {
  const version = ++state.artifactVersion
  const name = version === 1 ? 'artifact_create' : 'artifact_update'
  const callId = randomUUID()
  const args = {
    id: 'host-card',
    title: `${laneMarker(cwd)} card`,
    type: 'html',
    content: `<h1>${laneMarker(cwd)} version ${version}</h1>`,
  }
  const call = {
    role: 'assistant',
    content: [{ type: 'toolCall', id: callId, name, arguments: args }],
    stopReason: 'toolUse',
  }
  out({ type: 'message_end', message: call })
  persist(call)
  out({ type: 'tool_execution_start', toolCallId: callId, toolName: name, args })
  const result = {
    content: [{ type: 'text', text: `${laneMarker(cwd)} artifact saved` }],
    details: { ...args, version },
  }
  out({ type: 'tool_execution_end', toolCallId: callId, toolName: name, isError: false, result })
  const message = {
    role: 'toolResult',
    toolCallId: callId,
    toolName: name,
    ...result,
    isError: false,
  }
  out({ type: 'message_start', message })
  out({ type: 'message_end', message })
  persist(message)
  out({ type: 'message_start', message: text('') })
}
function linkTool({ cwd, out, persist, text }) {
  const toolCallId = randomUUID()
  const path = join(cwd, 'nested', 'guide.md')
  const args = { path, offset: 2 }
  const call = {
    role: 'assistant',
    content: [{ type: 'toolCall', id: toolCallId, name: 'read', arguments: args }],
    stopReason: 'toolUse',
  }
  out({ type: 'message_end', message: call })
  persist(call)
  out({ type: 'tool_execution_start', toolCallId, toolName: 'read', args })
  const result = { content: [{ type: 'text', text: `${laneMarker(cwd)} guide line two` }] }
  out({ type: 'tool_execution_end', toolCallId, toolName: 'read', isError: false, result })
  const message = { role: 'toolResult', toolCallId, toolName: 'read', ...result, isError: false }
  out({ type: 'message_start', message })
  out({ type: 'message_end', message })
  persist(message)
  out({ type: 'message_start', message: text('') })
}
function receiptTools({ cwd, out, persist, text }) {
  const path = join(cwd, 'remote.txt')
  writeFileSync(path, 'HOST_A_ONLY receipt edit\n')
  for (const [name, args, result] of [
    [
      'edit',
      { path, oldText: 'HOST_A_ONLY', newText: 'HOST_A_ONLY receipt edit' },
      {
        content: [{ type: 'text', text: 'Edited file' }],
        details: { diff: '-1 HOST_A_ONLY\n+1 HOST_A_ONLY receipt edit' },
      },
    ],
    [
      'bash',
      { command: 'npm test' },
      { content: [{ type: 'text', text: '1 test passed' }], details: { exitCode: 0 } },
    ],
  ]) {
    const toolCallId = randomUUID()
    const call = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: toolCallId, name, arguments: args }],
      stopReason: 'toolUse',
    }
    out({ type: 'message_end', message: call })
    persist(call)
    out({ type: 'tool_execution_start', toolCallId, toolName: name, args })
    out({ type: 'tool_execution_end', toolCallId, toolName: name, isError: false, result })
    const message = { role: 'toolResult', toolCallId, toolName: name, ...result, isError: false }
    out({ type: 'message_start', message })
    out({ type: 'message_end', message })
    persist(message)
    out({ type: 'message_start', message: text('') })
  }
}
function attachmentReply(message, images) {
  const paths = /<attached-files>\n([\s\S]*?)\n<\/attached-files>/.exec(message)?.[1]
  const documents = (paths ? paths.split('\n') : []).map((path) =>
    readFileSync(path, 'utf8').trim(),
  )
  const decoded = images.filter((image) => {
    const bytes = Buffer.from(image.data, 'base64')
    return (
      image.mimeType === 'image/png' &&
      bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    )
  })
  return `Attachments: ${documents.join('; ')} | ${decoded.length} image/png`
}
module.exports = { createToolState, laneMarker, artifact, linkTool, receiptTools, attachmentReply }
