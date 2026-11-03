import type { TurnViewModel } from '../turn-view-model'

/**
 * AN AGENT'S LATEST, AS BOTH ITS CARDS SAY IT (the owner, 2026-10-31).
 *
 * The agent had two cards — the pet's (pets/AgentPets.tsx) and the zoom's
 * (ZoomParts.tsx · AgentNode) — and they disagreed: the pet's said the turn
 * (its headline, your ask, the tool it is running, the live status), the
 * zoom's one line. The owner ruled the turn is what both say, in the zoom
 * card's ink: four lines at most, one each, never wrapping, so the zoom
 * painter can place the strip of thumbnails under it at a fixed offset.
 *
 * Built from the same TurnViewModel the board card renders (turn-view-model.ts);
 * `fallback` is what is said when no turn is known at all.
 */

/** Lines the block takes at most: the zoom card's geometry counts on it (zoom.css · .ag-latest). */
export const LATEST_LINES = 4

export function AgentLatest({ turn, fallback }: { turn: TurnViewModel | null; fallback: string }): React.JSX.Element {
  const tracked = turn && (turn.title !== null || turn.ask !== null || turn.tools.length > 0 || turn.latest !== null)
  if (!turn || !tracked) {
    // Nothing tracked: the screen's last line when there is one, else what the caller knows.
    return (
      <div className="ag-latest">
        <span className="ag-now done">{turn?.tail ?? fallback}</span>
      </div>
    )
  }
  const tool = turn.tools.at(-1) ?? null
  return (
    <div className="ag-latest">
      {turn.title && <b className="ag-title">{turn.title}</b>}
      {/* No "You:" line rather than an empty one, as the board card does. */}
      {turn.ask !== null && (
        <span className="ag-you">
          <em>You:</em> {turn.ask}
        </span>
      )}
      {tool && (
        <span className="ag-tool" title={tool}>
          <i aria-hidden="true">›_</i> {tool}
        </span>
      )}
      {turn.latest ? (
        <span className={`ag-now ${turn.latest.tone}`} title={turn.latest.text}>
          {turn.latest.tone !== 'done' && <i className="ag-dot" aria-hidden="true" />}
          {turn.latest.text}
        </span>
      ) : (
        <span className="ag-now done">Ready</span>
      )}
    </div>
  )
}
