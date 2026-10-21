import { useEffect, useState } from 'react'
import type { AgentMessage } from '@shared/rpc'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
import { Button } from '@/components/form'
import { Markdown } from '@/components/markdown/Markdown'
import { sessionTitle } from '@/lib/sessionTitle'
import { userMessageImages, userMessageText } from '@/features/chat/messageContent'
import { ChatImage } from '@/features/chat/ChatImage'
import { SessionFileTarget } from '@/features/files/SessionFileTarget'
import { PlatformProvider, usePlatform } from '@/platform/Platform'
import { useSavedConversation } from './completionActions'

/** A deliberately process-free reader: no composer, rewind, tools or session adoption. */
export function SavedConversationModal(): React.JSX.Element | null {
  const platform = usePlatform()
  const meta = useSavedConversation((s) => s.meta)
  const [messages, setMessages] = useState<AgentMessage[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false
    setMessages(null)
    setError(null)
    if (meta) {
      void window.phosphor.invoke('sessions:readTranscript', meta.path).then(
        (result) => {
          if (!cancelled) setMessages(result)
        },
        (reason: unknown) => {
          if (!cancelled) setError(String(reason))
        },
      )
    }
    return () => {
      cancelled = true
    }
  }, [meta, attempt])
  if (!meta) return null
  const close = (): void => useSavedConversation.setState({ meta: null })
  return (
    <PlatformProvider value={{ ...platform, terminal: false, scriptedArtifacts: false }}>
      <SessionFileTarget.Provider value={`saved:${meta.path}`}>
        <ModalOverlay onClose={close}>
          <div role="dialog" aria-modal="true" aria-label="Saved conversation">
            <ModalPanel
              width={900}
              title={
                sessionTitle({ explicitName: meta.name, firstUserText: meta.firstUserText }) ??
                'Saved conversation'
              }
              subtitle="Read-only · worktree removed. Restore the checkout to continue working."
              footer={<Button onClick={close}>Close</Button>}
            >
              <div className="max-h-[70vh] space-y-6 overflow-y-auto p-6">
                {error ? (
                  <div role="alert">
                    <p>{error}</p>
                    <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
                  </div>
                ) : messages === null ? (
                  <p role="status">Reading saved conversation…</p>
                ) : messages.length === 0 ? (
                  <p>No saved messages.</p>
                ) : (
                  messages.map((message, index) => <SavedMessage key={index} message={message} />)
                )}
              </div>
            </ModalPanel>
          </div>
        </ModalOverlay>
      </SessionFileTarget.Provider>
    </PlatformProvider>
  )
}

function SavedMessage({ message }: { message: AgentMessage }): React.JSX.Element | null {
  if (message.role === 'custom' || message.role === 'customMessage') {
    if (message.display === false) return null
    return (
      <pre className="whitespace-pre-wrap break-words">
        {JSON.stringify(message.content, null, 2)}
      </pre>
    )
  }
  if (message.role === 'compactionSummary' || message.role === 'branchSummary')
    return <Markdown inAppLinks={false} text={message.summary} />
  if (message.role === 'bashExecution')
    return (
      <details>
        <summary>{message.command}</summary>
        <pre className="whitespace-pre-wrap break-words">{message.output}</pre>
      </details>
    )
  if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'toolResult')
    return null
  const content = (
    <>
      {userMessageImages(message)?.map((image, i) => (
        <ChatImage key={i} image={image} className="max-h-40 rounded-lg" />
      ))}
      {message.role !== 'assistant' && (
        <Markdown inAppLinks={false} text={userMessageText(message)} />
      )}
      {message.role === 'assistant' &&
        message.content.map((block, i) =>
          block.type === 'text' ? (
            <Markdown key={i} inAppLinks={false} text={block.text} />
          ) : block.type === 'thinking' && block.thinking ? (
            <details key={i}>
              <summary>Thinking</summary>
              <Markdown inAppLinks={false} text={block.thinking} />
            </details>
          ) : block.type === 'toolCall' ? (
            <details key={i}>
              <summary>{block.name}</summary>
              <pre className="whitespace-pre-wrap break-words">
                {JSON.stringify(block.arguments, null, 2)}
              </pre>
            </details>
          ) : null,
        )}
    </>
  )
  return message.role === 'toolResult' ? (
    <details>
      <summary>
        {message.toolName}
        {message.isError ? ' · error' : ''}
      </summary>
      {content}
    </details>
  ) : (
    <article className="space-y-2">
      <div className="text-text-tertiary text-sm">
        {message.role === 'user' ? 'You' : 'Assistant'}
      </div>
      {content}
    </article>
  )
}
