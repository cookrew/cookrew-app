import { CrIcon, type CrIconName } from '../icons'
import type { TurnViewModel } from '../turn-view-model'

/**
 * THE turn block. One component, one set of class names, rendered identically
 * by the canvas card (TerminalNode) and the agents sidebar row (AgentRow).
 * Neither owns a copy of this markup.
 *
 * Skin is the container's job: these class names are styled for the dark card
 * in styles.css and re-skinned for the cream sidebar in agent-sidebar.css.
 */

/** Vibe-island shows a per-tool view; the trail gets a per-tool glyph. */
const TOOL_GLYPHS: [RegExp, CrIconName][] = [
  [/^Bash/i, 'bash'],
  [/^(Read|Write|Edit|Update|Create|NotebookEdit)/i, 'note'],
  [/^(Grep|Glob|Search|Find)/i, 'search'],
  [/^Web/i, 'browser'],
  [/^(Task|Agent)/i, 'agent'],
]

function toolGlyph(toolCall: string): CrIconName {
  return TOOL_GLYPHS.find(([re]) => re.test(toolCall))?.[1] ?? 'dot'
}

export function TurnView({ model }: { model: TurnViewModel }): React.JSX.Element {
  const { title, ask, tools, latest, pendingInput, tail } = model

  // The shell-tail path belongs to an agent with NOTHING tracked — not to one
  // whose ask is merely unknown. A self-healed turn (see turnViewOf) has no
  // ask but does have a title, a live status verb and a tool trail; keying
  // this branch on `ask` alone collapsed those cards to the screen's last
  // line, which under a running agent is the bare '❯' input prompt.
  if (ask === null && latest === null && title === null && tools.length === 0) {
    return (
      <>
        {tail === null ? (
          <div className="vi-ready">Ready</div>
        ) : (
          <div className="vi-latest done">{tail}</div>
        )}
        <PendingInput text={pendingInput} />
      </>
    )
  }

  return (
    <>
      {title && <div className="vi-turn-title">{title}</div>}
      {/* No "You:" line rather than an empty one: the tracker joined this turn
          late and does not know the ask. Better a missing row than a blank
          label implying the user sent nothing. */}
      {ask !== null && (
        <div className="vi-you">
          <span className="vi-you-label">You:</span> {ask}
        </div>
      )}
      {/* What it's doing RIGHT NOW: the status verb says it's busy, the trail
          says with what. Newest last, older calls dimmed. */}
      {tools.length > 0 && (
        <div className="vi-tools">
          {tools.map((toolCall, i) => (
            <div
              key={`${i}-${toolCall}`}
              className={`vi-tool ${i === tools.length - 1 ? 'latest' : 'older'}`}
              title={toolCall}
            >
              <span className="vi-tool-glyph">
                <CrIcon name={toolGlyph(toolCall)} />
              </span>{' '}
              {toolCall}
            </div>
          ))}
        </div>
      )}
      {latest ? (
        <div className={`vi-latest ${latest.tone}`}>
          {latest.tone !== 'done' && <span className="vi-dot pulse" />}
          {/* Wrapped, not bare: a text node inside a flex row cannot be
              ellipsed — text-overflow has nothing to apply to — so the
              sidebar's one-line rows hard-cut mid-word instead. */}
          <span className="vi-latest-text">{latest.text}</span>
        </div>
      ) : (
        <div className="vi-ready">Ready</div>
      )}
      <PendingInput text={pendingInput} />
    </>
  )
}

function PendingInput({ text }: { text: string | null }): React.JSX.Element | null {
  if (!text) return null
  return (
    <div className="vi-pending">
      <span className="vi-pending-label">typing:</span> {text}
      <span className="vi-caret">▍</span>
    </div>
  )
}
