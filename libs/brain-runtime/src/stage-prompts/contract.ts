import { BRAIN_ENTITY_KINDS, BRAIN_MEMORY_TYPES, BRAIN_PREDICATES } from '@phosphor/shared/brain'

/** Each no-session call needs its complete wire shape, not a reference to an earlier call. */
export const EXTRACTION_CONTRACT = `Registry refs r1… are offered entities; new refs must be n1…; claims c1…; segment handles s1… are local to this call.
Entity kinds: ${BRAIN_ENTITY_KINDS.join(', ')}
Memory types: ${BRAIN_MEMORY_TYPES.join(', ')}
Predicates: ${BRAIN_PREDICATES.join(', ')} (no about).
Epistemic: observed, reported, inferred. Dates ISO or null. branch true only for branch-specific facts.
Entity descriptions are evidence-derived disambiguators of at most 160 characters. Keys are only explicitly stated stable identifiers, never guessed names or contact details; keys may be empty.
Return this JSON shape (the example values illustrate shape, never copy unsupported facts):
{"entities":[{"ref":"n1","label":"Harbor","kind":"project","aliases":[],"description":"Customer service workflow","keys":[{"namespace":"project-code","value":"HBR-27"}]}],"claims":[{"ref":"c1","text":"Harbor is part of Kestrel.","type":"fact","epistemic":"reported","mentions":["n1","r1"],"links":[{"subject":"n1","predicate":"part_of","object":"r1","segment":"s1","quote":"Harbor is part of Kestrel."}],"validFrom":null,"validTo":null,"branch":false,"quotes":[{"segment":"s1","quote":"Harbor is part of Kestrel."}]}],"parents":[{"entity":"n1","status":"stated","claim":"c1"}]}.
Every new project/component/document/team needs a parents assessment: stated plus a claim with a structural link whose subject is that entity, not_stated or unclear with claim:null. No name-in-sentence requirement for links: support is their verbatim quote. Every claim needs a quote, and every link needs its own quote. No quote may cross an elision marker.`
