/**
 * #ARTIFACT IN THE PROMPT, AS @AGENT IS (owner, 2026-11-01): "#Route plan"
 * names a note or a browser of this workspace, and the box wires it to the
 * agent it is sent to, so it joins that agent's browsers and notes.
 *
 * SAID AS THE CLI REACHES IT (owner, 2026-11-09): an agent sent `the note
 * "screening-config"` went looking in Apple Notes and the filesystem before it
 * found Cookrew. What is sent names the card the way the CLI does: a note
 * `cookrew note "Route plan"`, a browser `cookrew browser "localhost:5173"`,
 * and a teammate named among the words `cookrew ask "Forge"`. The note's words
 * run as they are (main/bare-card.ts); a teammate is asked by name from any
 * card of the workspace (main/ask-reach.ts).
 *
 * Names have spaces in them, so a reference is matched against the names
 * there are, longest first, as the @mention is (prompt-target.ts).
 */

export interface PromptArtifact {
  id: string
  name: string
  kind: 'note' | 'browser'
  /** The agents wired to it already. */
  owners: readonly string[]
}

export interface NamedAgent {
  id: string
  name: string
}

interface NameRef<T> {
  /** Where the sigil is, and where the name ends. */
  start: number
  end: number
  item: T
}

export interface ArtifactRef {
  artifact: PromptArtifact
  /** Where the "#" is, and where the name ends. */
  start: number
  end: number
}

export interface AgentRef {
  agent: NamedAgent
  /** Where the "@" is, and where the name ends. */
  start: number
  end: number
}

/** A name ends at the text's end, a space, or punctuation. */
const ENDS_NAME = /^$|^[\s,.;:!?)\]}'"]/u

/** Every sigil + name in the text that names one of the items, in order. */
function nameRefs<T extends { name: string }>(text: string, sigil: '@' | '#', items: readonly T[]): NameRef<T>[] {
  const longestFirst = [...items].filter((a) => a.name.trim()).sort((a, b) => b.name.length - a.name.length)
  const out: NameRef<T>[] = []
  for (let i = text.indexOf(sigil); i !== -1; i = text.indexOf(sigil, i + 1)) {
    if (i > 0 && !/\s/u.test(text[i - 1])) continue
    const body = text.slice(i + 1)
    const hit = longestFirst.find(
      (a) => body.slice(0, a.name.length).toLowerCase() === a.name.toLowerCase() && ENDS_NAME.test(body.slice(a.name.length, a.name.length + 1))
    )
    if (!hit) continue
    out.push({ item: hit, start: i, end: i + 1 + hit.name.length })
    i += hit.name.length
  }
  return out
}

/** Every "#Name" in the text that names an artifact, in order. */
export function artifactRefs(text: string, artifacts: readonly PromptArtifact[]): ArtifactRef[] {
  return nameRefs(text, '#', artifacts).map(({ item, start, end }) => ({ artifact: item, start, end }))
}

/**
 * Every "@Name" in the text that names a teammate, in order. An "@Name"
 * leading the words says who they go to instead (prompt-target.ts ·
 * mentionTarget), and is gone from them before they are read here.
 */
export function agentRefs(text: string, agents: readonly NamedAgent[]): AgentRef[] {
  return nameRefs(text, '@', agents).map(({ item, start, end }) => ({ agent: item, start, end }))
}

/** A name as a shell argument: double quotes, unless the name holds what they would not keep. */
export function shellName(name: string): string {
  return /^[^"$`\\!]*$/u.test(name) ? `"${name}"` : `'${name.replace(/'/gu, `'\\''`)}'`
}

/** How the CLI reaches a card: `cookrew note "Name"`, `cookrew browser "Name"`, `cookrew ask "Name"`. */
export function cardCommand(verb: PromptArtifact['kind'] | 'ask', name: string): string {
  return `cookrew ${verb} ${shellName(name)}`
}

/** The words to send: each "#Name" and teammate "@Name" said as the command that reaches it. */
export function expandRefs(text: string, refs: readonly ArtifactRef[], teammates: readonly AgentRef[] = []): string {
  const spans = [
    ...refs.map((ref) => ({ start: ref.start, end: ref.end, said: cardCommand(ref.artifact.kind, ref.artifact.name) })),
    ...teammates.map((ref) => ({ start: ref.start, end: ref.end, said: cardCommand('ask', ref.agent.name) }))
  ].sort((a, b) => a.start - b.start)
  let out = ''
  let at = 0
  for (const span of spans) {
    // Inside a name already said (a note called "ping @Forge").
    if (span.start < at) continue
    out += `${text.slice(at, span.start)}${span.said}`
    at = span.end
  }
  return out + text.slice(at)
}

export interface Pending {
  sigil: '@' | '#'
  /** Where the sigil is. */
  start: number
  query: string
}

/**
 * The "@…" or "#…" being typed at the end of the text, if it is still on its
 * way to a name: some name could still become it (suggestionsFor) and none
 * is it yet. Null once the
 * name is whole (and a space follows), or when nothing could match.
 */
export function pendingName(text: string, names: { '@': readonly string[]; '#': readonly string[] }): Pending | null {
  for (let i = text.length - 1; i >= 0; i -= 1) {
    const sigil = text[i]
    if (sigil !== '@' && sigil !== '#') continue
    if (i > 0 && !/\s/u.test(text[i - 1])) continue
    const query = text.slice(i + 1)
    const q = query.toLowerCase()
    const list = names[sigil]
    if (list.some((name) => name.toLowerCase() === q)) return null
    if (suggestionsFor(query, list.map((name) => ({ name })), 1).length > 0) return { sigil, start: i, query }
    // "#ro" may still be inside a longer reference further left: keep looking.
  }
  return null
}

/** What a pending name could become: names that start with it, then (one word typed) names that contain it. */
export function suggestionsFor<T extends { name: string }>(query: string, items: readonly T[], max = 6): T[] {
  const q = query.toLowerCase()
  const starts = items.filter((item) => item.name.toLowerCase().startsWith(q))
  const contains = q && !/\s/u.test(q) ? items.filter((item) => !starts.includes(item) && item.name.toLowerCase().includes(q)) : []
  return [...starts, ...contains].slice(0, max)
}
