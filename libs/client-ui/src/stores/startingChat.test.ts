import { beforeEach, describe, expect, it } from 'vitest'
import { useStartingChatStore } from './startingChat'

const reset = (): void => useStartingChatStore.setState({ starting: null, draft: null })

beforeEach(reset)

describe('startingChat', () => {
  it('stands in for the session from the keystroke until it exists', () => {
    useStartingChatStore.getState().begin({ workspacePath: '/repo', prompt: 'hey!' })
    expect(useStartingChatStore.getState().starting).toMatchObject({
      workspacePath: '/repo',
      prompt: 'hey!',
      phase: 'branching',
    })

    useStartingChatStore.getState().setPhase('starting')
    expect(useStartingChatStore.getState().starting?.phase).toBe('starting')

    useStartingChatStore.getState().finish()
    expect(useStartingChatStore.getState().starting).toBeNull()
  })

  it('ignores a phase report once the chat is no longer starting', () => {
    useStartingChatStore.getState().setPhase('starting')
    expect(useStartingChatStore.getState().starting).toBeNull()
  })

  /**
   * The composer that sent the message is unmounted by `begin`, so a failed
   * start has nowhere to put the text back except here.
   */
  it('hands the message back as a draft when the start fails', () => {
    useStartingChatStore.getState().begin({ workspacePath: '/repo', prompt: 'hey!' })
    useStartingChatStore.getState().restore({
      workspacePath: '/repo',
      text: 'hey!',
      attachments: [],
      message: "Couldn't start this session. boom",
    })

    const state = useStartingChatStore.getState()
    expect(state.starting).toBeNull()
    expect(state.draft).toMatchObject({ workspacePath: '/repo', text: 'hey!' })

    useStartingChatStore.getState().clearDraft()
    expect(useStartingChatStore.getState().draft).toBeNull()
  })

  /**
   * Otherwise the failed send's text would be re-injected into the composer
   * the moment the NEW send finished, on top of whatever it had become.
   */
  it('drops a pending draft when a new chat is sent', () => {
    useStartingChatStore.getState().restore({
      workspacePath: '/repo',
      text: 'old',
      attachments: [],
      message: 'failed',
    })
    useStartingChatStore.getState().begin({ workspacePath: '/repo', prompt: 'new' })
    expect(useStartingChatStore.getState().draft).toBeNull()
  })
})
