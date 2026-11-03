import { CrIcon } from '../icons'
import type { PromptArtifact } from './artifact-refs'

/**
 * THE ITEM ATTACHED TO THE WORDS (owner design, 2026-11-04): in a browser's or
 * a note's full view that no agent has used, the item rides the prompt as a
 * #ref chip, and the new agent gets it (prompt-words.ts · withItemRef). × leaves
 * it out until the view moves.
 */
export function ItemRefChip({ item, onRemove }: { item: PromptArtifact; onRemove: () => void }): React.JSX.Element {
  return (
    <span className="cr-prompt-ref" title={`The ${item.kind} "${item.name}" goes with the words`}>
      <CrIcon name={item.kind} />
      <b>#{item.name}</b>
      <button type="button" aria-label={`Leave ${item.name} out`} title="Leave it out" onMouseDown={(e) => e.preventDefault()} onClick={onRemove}>
        ×
      </button>
    </span>
  )
}
