import type { KnownContext } from '@phosphor/memory-engine/types'

const INSTRUCTION = `<knowledge_extraction>
Phosphor queued this lane for knowledge extraction. You are a private, read-only copy of the lane: you have its full context, but nothing you write reaches the user or the original lane. Do not call tools, do not continue the task and do not ask questions. Reply with exactly one JSON object and no other text.

## What to keep
Write down only what a future agent must know before working on this project again and could not find quickly in the code or docs:
- decisions, with the reason when one was given
- facts about people, teams, systems, components and documents that are hard to rediscover
- conventions and preferences the user stated
- procedures that worked and pitfalls that cost time
- risks and open questions that still matter
Skip anything transient: steps, retries, tool noise, status updates and things that only mattered inside this conversation. Fewer, sharper memories are better. If nothing is worth keeping, return an empty "memories" list.

## Already known
Brain already holds these memories, including any this lane recalled with brain_search or brain_related. Never restate memories just to repeat them. When this lane itself states or relies on an existing memory again, outside brain_search or brain_related output, include it again with a fresh quote from this lane so Brain can re-confirm it. When this lane changed something, set "supersedes" to the old memory's id.
{{MEMORIES}}
Existing entities. Use an id below as "subject" or "object" instead of a new key for the same thing:
{{ENTITIES}}
Text that came back from brain_search or brain_related is already in Brain. Never extract it.

## Rules
1. One memory is one self-contained sentence a reader understands without this conversation. Name things. Keep exact values: numbers, dates, ids, names.
2. Use only what this conversation shows. If something was corrected later, keep only the corrected version.
3. Back each memory with one or two quotes copied exactly from the conversation: messages, tool output, tool call arguments or a summary. Each quote is at most 160 characters of contiguous text. Never paraphrase inside a quote and leave out role labels.
4. "kind" is "observed" when seen directly in tool output or files, "reported" when the user or a document stated it, and "inferred" when it is your own conclusion.
5. Never include secrets (keys, tokens, passwords, connection strings), personal contact details or raw data rows.
6. When a memory states how two entities relate, set "object" to the other entity and "literal" to null, and name both in the sentence. Otherwise use predicate "about", "object": null and put the value in "literal".
7. Declare acronyms the project relies on as concept entities, with the long form in "aliases".
8. At most {{MAX}} memories and 15 new entities.

## Vocabulary
Entity kinds: person, team, organization, project, component, document, concept, event.
Predicates, read subject → object: owns, works_on, member_of, part_of, depends_on, uses, decided, prefers, blocks, affects, related_to, about.
"type" is decision, open (still unresolved), risk, procedure, preference or fact.
"branch" is true only when the memory holds just for this lane's branch or unfinished work.

## Output
{"summary":"One or two sentences: what this lane worked on and where it ended.","entities":[{"key":"kebab-case","label":"Name","kind":"component","aliases":[]}],"memories":[{"subject":"key or id","predicate":"uses","object":"key or id","literal":null,"summary":"Sentence.","kind":"observed","type":"fact","branch":false,"validFrom":"YYYY-MM-DD or null","quotes":["exact words"],"supersedes":null}]}
</knowledge_extraction>`

export function extractionPrompt(known: KnownContext): string {
  const memories = known.memories.map((m) => `- [${m.id}] ${m.summary}`).join('\n') || '(none)'
  const entities =
    known.entities
      .map((e) => `- ${e.id}: ${e.label} (${e.kind}; aliases ${e.aliases.join(', ')})`)
      .join('\n') || '(none)'
  return INSTRUCTION.replace('{{MEMORIES}}', () => memories)
    .replace('{{ENTITIES}}', () => entities)
    .replace('{{MAX}}', '20')
}
