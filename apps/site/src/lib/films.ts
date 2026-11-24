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
      'Opt into Brain on Desktop to keep decisions from selected lanes. Reach your own Hosts from Desktop or the PWA.',
    ],
  },
  {
    id: 'brain-walkthrough',
    title: 'Follow a handover in Brain',
    description:
      'Read a lane, walk a relationship and see what Brain Agent changed. Silent walkthrough of Desktop’s opt-in knowledge graph.',
    guide: '/guides/brain/',
    steps: [
      'Open Settings → Brain, read the model terms, enable it and wait for the local embedding model.',
      'Queue a local lane from its menu. Its read saves at once. Open What changed to see how it was read or undo the save.',
      'Start with your card. Follow a sentence to the other end. Ask a question to light its trail on the map.',
      'Brain Agent checks links and repeats after reads settle. Inspect its reasons in What changed, or click Defrag to run a check yourself.',
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
