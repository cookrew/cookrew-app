// ONE ROW OF THE TRANSCRIPT, RE-RENDERED ONLY WHEN ITS OWN FACTS CHANGE
// (perf, 2026-10-04).
//
// TranscriptView re-renders on every scroll frame: the scroll handler reports
// the active block, the overlay stores it, and the view is its child. Until
// this file the rows were an inline map inside that render, so every frame
// rebuilt the element tree of EVERY row in the identity space — 1,048 divs on
// the owner's busiest card — and, for each of the up-to-60 loaded ones, ran
// the markdown parser over the whole reply again. Scrolling a long transcript
// was paying for the parse of text that had not changed since it landed.
//
// A row's inputs are few and stable: its identity, its block (an object that
// is replaced only when a fetch delivers it anew), whether it is the active
// one, the placeholder height while it has no block, the title mode, and the
// one translation that may be showing. memo() over those means a frame that
// changes which row is active re-renders two rows, not a thousand.
//
// The ref is forwarded, not re-created: TranscriptView keeps one stable ref
// callback per identity (its D6 note explains why), and a memoised row must
// receive that same callback or every render would still move every ref.

import { Fragment, forwardRef, memo, useContext, useMemo, useState } from 'react'
import { checkpointTitle, type TitleMode } from './checkpoint-sync'
import { MarkdownText } from './MarkdownText'
import type { CheckpointTranslation } from './TranscriptView'
import { isHarnessNotice, noticeLine } from '../../shared/harness-notice'
import type { TraceBlock } from '../../shared/trace-blocks'
import { TranscriptFaceContext } from './transcript-face'
import { TranscriptLookContext } from './transcript-look'
import { chatFoldLabel, chatLegsOf, latestStepLine, type ChatFold, type ChatStep } from './chat-fold'
import { PictureStrip, picturesOfTurn } from './pictures/PictureStrip'

export interface TranscriptRowProps {
  /** Checkpoint identity (TurnRecord.index). */
  id: number
  /** The loaded block, or undefined while this identity is a placeholder. */
  block: TraceBlock | undefined
  active: boolean
  /** Placeholder height; only read while `block` is undefined, and only
   *  passed then, so a changing estimate does not re-render loaded rows. */
  placeholderHeight: number | undefined
  titleMode: TitleMode
  /** The translation showing for THIS row, or null. Every other row's is null. */
  translated: CheckpointTranslation | null
  /** The card the transcript is of: where its pasted pictures are read from. */
  terminalId?: string | null
  /** The newest row: the only turn words can still be waiting on. A file a
   *  compact rotated away keeps whatever was queued in it for ever. */
  last?: boolean
}

export const TranscriptRow = memo(
  forwardRef<HTMLDivElement, TranscriptRowProps>(function TranscriptRow(
    { id, block, active, placeholderHeight, titleMode, translated, terminalId = null, last = false },
    ref
  ) {
    const legs = useMemo(() => (block ? chatLegsOf(block) : []), [block])
    // The prompt's screenshots, drawn under its words (CHAT and LOG; LIVE keeps "[Image #N]").
    const pictures = useMemo(() => (block ? picturesOfTurn(block, terminalId) : []), [block, terminalId])
    return (
      <div
        className={
          block ? `ctx-block${active ? ' active' : ''}` : `ctx-placeholder${active ? ' active' : ''}`
        }
        data-checkpoint={id}
        style={block ? undefined : { height: placeholderHeight }}
        ref={ref}
      >
        {block ? (
          <>
            <div className="ctx-block-head">
              <span className="ctx-block-idx">T{id}</span>
              <span className="ctx-block-title">{checkpointTitle(block, titleMode)}</span>
            </div>
            {/* Prompt stays VERBATIM (pre-wrap) — the human's exact words,
                unless the reader asked for this checkpoint translated, in
                which case the words shown are the translation's. Marked, so
                "these are not the words that were typed" is visible rather
                than inferred. */}
            {/* A turn the harness started is not the owner's bubble: one quiet
                line saying what woke the agent (harness-notice.ts). */}
            {isHarnessNotice(block.prompt) ? (
              <div className="ctx-block-notice" role="note">
                {noticeLine(block.prompt)}
              </div>
            ) : (
              <div className="ctx-block-prompt" data-translated={translated ? '' : undefined}>
                {(translated?.prompt ?? block.prompt) || '(empty prompt)'}
              </div>
            )}
            <PictureStrip pictures={pictures} className="ctx-prompt-pics" expandable />
            {/* What you said while it worked stands in the open, between the
                stretches of work it fell between (chat-fold.ts). A translation
                covers the whole reply: it is the closing answer, the rest stay
                as they ran. */}
            {legs.map((leg, i) => {
              const closing = translated !== null && i === legs.length - 1
              return (
                <Fragment key={i}>
                  {leg.words !== null && <div className="ctx-block-prompt">{leg.words}</div>}
                  <AgentLeg fold={leg.fold} answer={(closing ? translated.reply : null) ?? leg.fold.answer} translated={closing} />
                </Fragment>
              )
            })}
            {last &&
              block.queued?.map((words, i) => (
                <div key={i} className="ctx-block-prompt ctx-block-queued">
                  {words}
                  <span className="ctx-queued-tag">queued</span>
                </div>
              ))}
          </>
        ) : (
          <span className="ctx-placeholder-idx">T{id}</span>
        )}
      </div>
    )
  })
)

/** THE AGENT'S SIDE OF THE CHAT: its face, and one bubble with what it ran and what it said (transcript-face.ts). */
function AgentLeg({ fold, answer, translated }: { fold: ChatFold; answer: string; translated: boolean }): React.JSX.Element | null {
  const face = useContext(TranscriptFaceContext)
  const look = useContext(TranscriptLookContext)
  const [open, setOpen] = useState(false)
  // The log prints every step, as the terminal does; the chat folds them until asked.
  const unfolded = look === 'log' || open
  if (fold.steps.length === 0 && !answer) return null
  return (
    <div className="ctx-chat-agent">
      <span className="ctx-chat-face" aria-hidden="true">
        {face}
      </span>
      <div className="ctx-chat-bubble">
        {fold.steps.length > 0 && (
          <div className={`ctx-chat-process${unfolded ? ' open' : ''}`}>
            <button type="button" className="ctx-process-toggle" aria-expanded={unfolded} onClick={() => setOpen((o) => !o)}>
              <span className="ctx-process-label">{chatFoldLabel(fold)}</span>
              {!answer && <span className="ctx-process-now">{latestStepLine(fold.steps)}</span>}
            </button>
            {unfolded && (
              <div className="ctx-chat-tools">
                {fold.steps.map((step, i) => (
                  <StepRow key={i} step={step} />
                ))}
              </div>
            )}
          </div>
        )}
        {/* Reply renders MARKDOWN as React elements; .md is Fresco's flag. */}
        {answer && (
          <div className="ctx-block-reply md" data-translated={translated ? '' : undefined}>
            <MarkdownText source={answer} />
          </div>
        )}
      </div>
    </div>
  )
}

/** One step inside the fold: a thought, the words between steps, or a tool call with its result. */
function StepRow({ step }: { step: ChatStep }): React.JSX.Element {
  if (step.kind === 'thought') return <div className="ctx-block-thought">{step.text}</div>
  if (step.kind === 'said') {
    return (
      <div className="ctx-block-said md">
        <MarkdownText source={step.text} />
      </div>
    )
  }
  const { call } = step
  return (
    <div className="ctx-block-tool">
      <div className="ctx-tool-call">
        <span className="ctx-tool-name">{call.tool}</span>
        {call.args && <span className="ctx-tool-args">{call.args}</span>}
      </div>
      {call.result && <div className="ctx-tool-result">{call.result}</div>}
    </div>
  )
}
