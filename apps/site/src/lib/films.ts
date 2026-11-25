export const films = [
  {
    id: 'phosphor-overview',
    title: 'From a task to work you can inspect',
    description:
      'A tour of lanes, review, Brain and your own machines. Silent, text-led overview; no model performance or completion-time claims.',
    guide: '/guides/',
    steps: [
      'Start with a lane: choose a repository and model, and keep independent tasks on separate worktrees.',
      'Inspect tool calls, changed files and versioned artifacts instead of relying on a final message.',
      'Use the PR inspector to check evidence. Hand-off buttons draft a message; you decide whether to send it.',
      'Opt into Brain on Desktop to follow relationships across selected lanes. Reach your own Hosts from Desktop or the PWA.',
    ],
  },
  {
    id: 'brain-walkthrough',
    title: 'Follow a handover in Brain',
    description:
      'Read a lane, walk a relationship and see what Brain Agent changed. Silent walkthrough of Desktop’s opt-in knowledge graph.',
    guide: '/guides/brain/',
    steps: [
      'On Desktop, read the terms in Settings → Brain and enable local search. Brain Agent checks new knowledge up to six times a day; turn off automatic checks to use Defrag only.',
      'Queue a local lane from its menu. Extraction calls the lane’s provider. A read saves when it finishes.',
      'Open What changed to see each saved read and Brain Agent change. Inspect how a lane was read or undo an eligible change.',
      'Follow the handover sentence from Rina Okafor to Tom Lee. His card separates Now from Before. Ask about the handover to see the memories and their trail.',
    ],
  },
  {
    id: 'lane-to-review',
    title: 'Close the loop on a lane',
    description:
      'Read the work, inspect a pull request and return to the right conversation. Silent walkthrough; nothing merges or sends automatically.',
    guide: '/guides/daily-work/#merge',
    steps: [
      'Review the lane’s tool output and Changes before treating the work as finished.',
      'Open its PR pill for checks, reviews, threads and activity. Missing checks are not passing checks.',
      'Use Fix or Address to draft a hand-off. Read and send it yourself; Phosphor stays read-only on GitHub.',
      'Use a Slack thread pill to revisit a link already in the conversation, or a notification to return to work needing attention.',
    ],
  },
]
