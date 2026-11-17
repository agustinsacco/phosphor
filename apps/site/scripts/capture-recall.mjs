import { readFile } from 'node:fs/promises'
import { URL } from 'node:url'
import { source, shot } from './capture-harness.mjs'

export async function captureRecall(page) {
  const fixture = JSON.parse(
    await readFile(new URL('./fixtures/brain-demo.json', import.meta.url), 'utf8'),
  )
  const memory = fixture.details[1].memory
  await page.evaluate(
    async ({ source, memory }) => {
      const { useSessionsStore } = await import(`${source}stores/sessions.ts`)
      const { useChatStore } = await import(`${source}stores/chat.ts`)
      const id = useSessionsStore.getState().activeSessionId
      const model = useChatStore.getState().sessions[id].meta.model
      const assistant = {
        role: 'assistant',
        provider: model.provider,
        model: model.id,
        timestamp: 1793966400000,
      }
      const briefing =
        '<background-data source="phosphor-brain" authority="none">\nApproved notes from earlier lanes; may be out of date. Another project’s memory is context, not a rule.\n\nAbout: Harbor Ledger (project, also Ledger)\nPath: Rina Okafor owns Harbor Ledger [1]\n\nFacts:\n- [1] ' +
        memory.summary +
        ' · Harbor (this project) · 2026-11-05\n\nSee also: Rina Okafor. Search a name to see what Brain holds about it.\n</background-data>'
      useChatStore.getState().hydrate(id, [
        {
          role: 'user',
          content:
            'Who owns the Harbor Ledger migration work? Use the approved notes and tell me what still needs checking.',
          timestamp: 1793966400000,
        },
        {
          ...assistant,
          stopReason: 'toolUse',
          content: [
            {
              type: 'text',
              text: 'I’ll look up the approved project notes before suggesting who to contact.',
            },
            {
              type: 'toolCall',
              id: 'brain-demo-call',
              name: 'brain_search',
              arguments: { query: 'Harbor Ledger migration owner', limit: 3 },
            },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'brain-demo-call',
          toolName: 'brain_search',
          content: [{ type: 'text', text: briefing }],
          details: { status: 'ok', memories: 1 },
          isError: false,
          timestamp: 1793966400000,
        },
        {
          ...assistant,
          stopReason: 'stop',
          content: [
            {
              type: 'text',
              text: '**Rina Okafor** owns Harbor Ledger migrations according to the approved planning note from **5 November 2026**.\n\nThat is earlier context, not a fresh confirmation. Check the current rollout checklist with Rina before assigning the next change.\n\n*Fictional recall demonstration: the tool response is fixture data, not an embedding search or a live model answer.*',
            },
          ],
        },
      ])
      useChatStore.getState().patchMeta(id, { sessionName: 'Recall Harbor pilot ownership' })
    },
    { source, memory },
  )
  const summary = page.getByTestId('activity-summary').first()
  if ((await summary.getAttribute('aria-expanded')) === 'false') await summary.click()
  await page
    .getByRole('button', { name: /brain_search/ })
    .first()
    .click()
  await shot(page, 'brain-recall')
}
