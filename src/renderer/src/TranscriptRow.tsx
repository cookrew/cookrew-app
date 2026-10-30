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

import { forwardRef, memo, useContext } from 'react'
import { checkpointTitle, type TitleMode } from './checkpoint-sync'
import { MarkdownText } from './MarkdownText'
import type { CheckpointTranslation } from './TranscriptView'
import type { TraceBlock } from '../../shared/trace-blocks'
import { TranscriptFaceContext } from './transcript-face'

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
}

export const TranscriptRow = memo(
  forwardRef<HTMLDivElement, TranscriptRowProps>(function TranscriptRow(
    { id, block, active, placeholderHeight, titleMode, translated },
    ref
  ) {
    const face = useContext(TranscriptFaceContext)
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
            <div className="ctx-block-prompt" data-translated={translated ? '' : undefined}>
              {(translated?.prompt ?? block.prompt) || '(empty prompt)'}
            </div>
            {/* THE AGENT'S SIDE OF THE CHAT: its face, and one bubble with
                what it ran and what it said (transcript-face.ts). */}
            {(block.activity.length > 0 || block.reply) && (
              <div className="ctx-chat-agent">
                <span className="ctx-chat-face" aria-hidden="true">
                  {face}
                </span>
                <div className="ctx-chat-bubble">
                  {block.activity.length > 0 && (
                    <div className="ctx-chat-tools">
                      {block.activity.map((call, i) => (
                        <div key={i} className="ctx-block-tool">
                          <div className="ctx-tool-call">
                            <span className="ctx-tool-name">{call.tool}</span>
                            {call.args && <span className="ctx-tool-args">{call.args}</span>}
                          </div>
                          {call.result && <div className="ctx-tool-result">{call.result}</div>}
                        </div>
                      ))}
                    </div>
                  )}
                  {/* Reply renders MARKDOWN as React elements; .md is Fresco's flag. */}
                  {block.reply && (
                    <div className="ctx-block-reply md" data-translated={translated ? '' : undefined}>
                      <MarkdownText source={translated?.reply ?? block.reply} />
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        ) : (
          <span className="ctx-placeholder-idx">T{id}</span>
        )}
      </div>
    )
  })
)
