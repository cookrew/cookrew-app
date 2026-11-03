import { artifactRefs, type PromptArtifact } from './artifact-refs'
import { BAR_NAMES, BAR_STOPS, barStop, type ZoomDir } from '../zoom/zoom-path'

/**
 * THE PROMPT'S WORDS SAY WHO THEY GO TO (owner design, 2026-11-04; cut
 * docs/avatar-send-tasks/a-words). The placeholder names the receiver per
 * view, so an empty box already says where Enter goes:
 *
 *   an agent             Reply to <name>…
 *   an agent asleep      <name> is asleep · wakes on send
 *   devices, workspaces  New agent in <workspace>…   (the new agent lands in the active one)
 *   the crew             Describe a task for a new agent…
 *   the artifacts        New agent… · # adds a note or browser
 *   an item nobody used  New agent with #<item>…     (the item rides as a #ref chip)
 */

export type WordsStop = 'devices' | 'workspaces' | 'crew' | 'artifacts' | 'item'

/** The stop the box is read at: the bar's, or an item's full view. */
export function wordsStop({ dir, v, full }: { dir: ZoomDir; v: number; full: 'agent' | 'item' | null }): WordsStop {
  if (full === 'item') return 'item'
  const name = BAR_NAMES[dir][BAR_STOPS[dir].indexOf(barStop(dir, v))]
  if (name === 'devices' || name === 'workspaces' || name === 'artifacts') return name
  return 'crew'
}

const FOR_NEW = 'Describe a task for a new agent…'

export function promptPlaceholder({
  agent,
  stop,
  workspace,
  item
}: {
  agent: { readonly name: string; readonly status: string } | null
  stop: WordsStop
  /** The active workspace's name: a new agent made at the outer stops goes there. */
  workspace: string | null
  /** The item attached to the words (an item's full view nobody has used). */
  item: { readonly name: string } | null
}): string {
  if (agent) return agent.status === 'offline' ? `${agent.name} is asleep · wakes on send` : `Reply to ${agent.name}…`
  if (stop === 'item' && item) return `New agent with #${item.name}…`
  if ((stop === 'devices' || stop === 'workspaces') && workspace?.trim()) return `New agent in ${workspace.trim()}…`
  if (stop === 'artifacts') return 'New agent… · # adds a note or browser'
  return FOR_NEW
}

/**
 * The attached item rides the send as "#Name" ahead of the words, where
 * artifact-refs.ts reads it (said as what it is, and wired to the agent).
 * Words that name it already are left alone; so are no words.
 */
export function withItemRef(text: string, item: PromptArtifact | null, artifacts: readonly PromptArtifact[]): string {
  if (!item || !text.trim()) return text
  if (artifactRefs(text, artifacts).some((ref) => ref.artifact.id === item.id)) return text
  return `#${item.name}: ${text}`
}
