import type { ItemSnippet } from './item-search'

/**
 * Why a browser or note is in the board's results when its row would not say
 * so: the passage of the note's body, or the other tab, with the word marked.
 * The same band as an agent's checkpoint hit (.ags-hit).
 */
export function MatchLine({ match }: { match: ItemSnippet }): React.JSX.Element {
  return (
    <span className="ags-hit ags-item-hit" title={`${match.pre}${match.hit}${match.post}`}>
      <span className="ags-item-hit-text">
        {match.pre}
        {match.hit && <mark className="ags-mark">{match.hit}</mark>}
        {match.post}
      </span>
    </span>
  )
}
