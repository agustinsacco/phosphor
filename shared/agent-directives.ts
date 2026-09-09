/** Shared by the session prompt and Settings preview: one tool-scoped policy. */
export function subagentPolicyBlock(): string {
  return [
    '<phosphor_subagents>',
    'When sub-agent tools are available, use them only for genuinely broad, independent work.',
    '- Native Claude Code Agent/Task: prefer run_in_background: false when its schema supports it; wait for the findings.',
    '- pi subagent: follow its advertised schema. Do not add run_in_background; that parameter belongs to Agent.',
    '- Answer directly when you can. Reading a handful of files is not a fan-out.',
    '</phosphor_subagents>',
  ].join('\n')
}
