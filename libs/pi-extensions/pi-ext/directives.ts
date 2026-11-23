/**
 * The owner's directive override for each request, over the spawn's
 * `--append-system-prompt` base. It registers nothing until directives move
 * here, and no spawn loads it yet.
 */
export default function directivesExtension(_pi: object): void {}
