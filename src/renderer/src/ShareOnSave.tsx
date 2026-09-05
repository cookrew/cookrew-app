import {
  MKT_SERVE,
  fillCopy,
  servedPaymentRailsLabel
} from '../../shared/marketplace-copy'
import type { ServedPaymentRail } from '../../shared/served-payment-rails'
import {
  SUMMARY_MAX,
  TAGS_MAX,
  parseTagInput,
  summaryLooksGood,
  tagsLookGood
} from '../../shared/served-face-shape'

/**
 * SHARE ON SAVE — the one publish entry (owner ruling, 2026-08-26).
 *
 * The share question rides INSIDE the save sheet, not a second sheet after it:
 * one breath, one act. A follow-up sheet is a place to abandon; a section is a
 * place to glance past, and the default answers it safely — `just-me` publishes
 * nothing, so a user who reads none of this cannot open a door by accident.
 *
 * Retires the Board's WHO CAN CALL panel and the per-agent export toggles. R30
 * already deleted the per-agent grant matrix server-side (a caller talks to the
 * orch and nothing else); this is the UI finally agreeing with the protocol.
 */

export type ShareAccess = 'just-me' | 'account' | 'paid'

/** A well-formed price — mirrors `validPrice` in session-served.ts. */
export function priceLooksGood(value: string): boolean {
  return /^\d+(\.\d{1,2})?$/.test(value) && Number(value) > 0
}

/**
 * The primary's label. It renames when the click gains a consequence — a plain
 * SAVE that also published would be exactly the quiet-consequence bug this
 * product refuses everywhere else.
 */
export function saveButtonLabel(access: ShareAccess, busy: boolean): string {
  if (busy) return 'SAVING…'
  return access === 'just-me' ? 'SAVE' : 'SAVE · START SERVING'
}

/**
 * Can the sheet be submitted?
 *
 * A paid door with no price or ready rail cannot quote at 402, and a PUBLIC
 * door with no orch cannot answer anybody — the crew would save, start serving,
 * and hand the first caller's prompt to a bare shell (owner ruling, 2026-08-26). All are
 * refused HERE, at the moment of the act, rather than by the gate a caller
 * meets later: a silent save that 503s a stranger is a failure the owner never
 * sees and the caller cannot explain.
 *
 * `door` is the first agent terminal in the selection — the leader (owner
 * ruling, 2026-09-05: no orch node needed) — and null only when the selection
 * holds no terminal at all. A private save is unaffected — `just-me`
 * publishes nothing, so it needs no door.
 */
export function canSubmitShare(
  access: ShareAccess,
  priceUsd: string,
  door: string | null,
  paymentRails: readonly ServedPaymentRail[]
): boolean {
  if (access === 'just-me') return true
  if (door === null) return false
  return access !== 'paid' || (priceLooksGood(priceUsd) && paymentRails.length > 0)
}

/**
 * The face's words, as typed. A private save carries none, so they cannot
 * block it; a public one is refused HERE for the same shapes main refuses
 * (served-face.ts), so the button and the sentence arrive together.
 */
export function faceWordsLookGood(access: ShareAccess, summary: string, tagsRaw: string): boolean {
  if (access === 'just-me') return true
  return summaryLooksGood(summary) && tagsLookGood(parseTagInput(tagsRaw))
}

/**
 * A refusal from the main process, in the owner's words.
 *
 * The sheet blocks every reason it can see before the save, so anything that
 * reaches here is a reason it could NOT see — a template deleted underneath it,
 * an orch flag cleared between the sheet opening and the button — and the raw
 * `no-orch` the IPC returns is a token, not a sentence. Unknown reasons keep
 * their own text rather than being flattened to "unknown": a code we have not
 * met yet is still more useful than a word that means nothing.
 */
export function serveRefusalText(reason: string | undefined): string {
  if (reason === undefined) return 'the reason was not reported'
  if (reason === 'no-orch') return MKT_SERVE['mkt.serve.no-orch']
  if (reason === 'bad-price') return MKT_SERVE['mkt.serve.refused.bad-price']
  if (reason === 'priced-free-door') return MKT_SERVE['mkt.serve.refused.priced-free-door']
  if (reason === 'grant-unusable') return MKT_SERVE['mkt.serve.refused.grant-unusable']
  if (reason === 'no-payment-rail') return MKT_SERVE['mkt.serve.payment.required']
  if (reason === 'no-template') return 'that template is no longer on this machine.'
  if (reason === 'bad-summary') return `a summary is one line of at most ${SUMMARY_MAX} characters.`
  if (reason === 'bad-tags') return `tags are at most ${TAGS_MAX} lowercase words, letters, digits and dashes.`
  if (reason === 'desktop-only') return MKT_SERVE['mkt.serve.refused.desktop-only']
  return reason
}

export function ShareOnSave({
  access,
  priceUsd,
  paymentRails,
  door,
  summary,
  tagsRaw,
  onAccess,
  onPrice,
  onSummary,
  onTags,
  onConfigurePayments
}: {
  access: ShareAccess
  priceUsd: string
  paymentRails: readonly ServedPaymentRail[]
  /** The face's words, as typed — a sentence and a comma-separated tag list. */
  summary: string
  tagsRaw: string
  /**
   * The orch's name — the one door a caller ever reaches — or null when the
   * selection flags no orch. Null is a refusal, never a placeholder: this used
   * to fall back to the first picked terminal (and then to the word
   * 'Conductor'), which is how the sheet came to promise a door that did not
   * exist.
   */
  door: string | null
  onAccess: (next: ShareAccess) => void
  onPrice: (next: string) => void
  onSummary: (next: string) => void
  onTags: (next: string) => void
  onConfigurePayments: () => void
}): React.JSX.Element {
  const tags = parseTagInput(tagsRaw)
  const summaryBad = !summaryLooksGood(summary)
  const tagsBad = !tagsLookGood(tags)
  const option = (
    value: ShareAccess,
    title: string,
    sub: string
  ): React.JSX.Element => (
    <button
      type="button"
      className={`sos-opt${access === value ? ' sel' : ''}`}
      aria-pressed={access === value}
      onClick={() => onAccess(value)}
    >
      <span className="sos-dot" />
      <span className="sos-text">
        <span className="sos-t">{title}</span>
        <span className="sos-s">{sub}</span>
      </span>
    </button>
  )

  return (
    <div className="sos">
      <span className="tf-label">{MKT_SERVE['mkt.serve.who'].toUpperCase()}</span>
      {option(
        'just-me',
        MKT_SERVE['mkt.serve.who.none'],
        MKT_SERVE['mkt.serve.who.none.sub']
      )}
      {option(
        'account',
        MKT_SERVE['mkt.serve.who.free'],
        MKT_SERVE['mkt.serve.who.free.sub']
      )}
      {option('paid', MKT_SERVE['mkt.serve.who.paid'], MKT_SERVE['mkt.serve.who.paid.sub'])}

      {access === 'paid' && (
        <div className="sos-price">
          <input
            className="tf-input sos-price-input"
            value={priceUsd}
            inputMode="decimal"
            placeholder="2.50"
            aria-label={MKT_SERVE['mkt.serve.price.label']}
            onChange={(e) => onPrice(e.target.value)}
          />
          <span className="sos-unit">{MKT_SERVE['mkt.serve.price.unit']}</span>
          <span className="sos-rails">
            {paymentRails.length > 0
              ? fillCopy(MKT_SERVE['mkt.serve.rails.live'], {
                  rails: servedPaymentRailsLabel(paymentRails)
                })
              : MKT_SERVE['mkt.serve.rails.none']}
          </span>
          {paymentRails.length === 0 && (
            <button type="button" className="sos-setup" onClick={onConfigurePayments}>
              {MKT_SERVE['mkt.serve.payment.setup']}
            </button>
          )}
          {priceUsd.length > 0 && !priceLooksGood(priceUsd) && (
            <span className="sos-bad">a price has to be a number above zero</span>
          )}
        </div>
      )}

      {/*
        THE FACE'S WORDS, only once a public option is picked: what the
        listing says and what it is found by. Optional both — an owner who
        writes nothing lists a team with a title and a door, and that is a
        complete listing.
      */}
      {access !== 'just-me' && (
        <div className="sos-words">
          <input
            className="tf-input sos-summary-input"
            value={summary}
            maxLength={SUMMARY_MAX + 1}
            spellCheck={false}
            placeholder="One line on what this team does"
            aria-label="Summary"
            aria-invalid={summaryBad}
            onChange={(e) => onSummary(e.target.value)}
          />
          <span className={`sos-count${summaryBad ? ' sos-bad' : ''}`}>
            {summary.trim().length}/{SUMMARY_MAX}
          </span>
          <input
            className="tf-input sos-tags-input"
            value={tagsRaw}
            spellCheck={false}
            autoComplete="off"
            placeholder="tags, comma separated"
            aria-label="Tags"
            aria-invalid={tagsBad}
            onChange={(e) => onTags(e.target.value)}
          />
          {tagsBad && (
            <span className="sos-bad">
              up to {TAGS_MAX} tags — lowercase letters, digits and dashes, each once
            </span>
          )}
        </div>
      )}

      {access === 'paid' && paymentRails.length === 0 && (
        <div className="sos-door sos-door-bad" role="alert">
          <span className="sos-door-g">◆</span>
          <span className="sos-door-s">{MKT_SERVE['mkt.serve.payment.required']}</span>
        </div>
      )}

      {/*
        THE DOOR FACT, shown only once a public option is picked: it answers the
        fear that arrives at that exact moment ("which of my agents are
        exposed?"). Before then it is noise.
      */}
      {access !== 'just-me' && door !== null && (
        <div className="sos-door">
          <span className="sos-door-g">◫</span>
          <span className="sos-door-s">
            {MKT_SERVE['mkt.serve.door'].replace('{orch}', door)}
          </span>
        </div>
      )}

      {/*
        THE REFUSAL, in the same slot the door fact would have occupied — the
        answer to "which of my agents are exposed?" is "none of them, and that
        is the problem". Rendered beside a disabled primary so the button and
        the sentence arrive together; a disabled button with no sentence is the
        touch-invisible dead end this product keeps having to fix.
      */}
      {access !== 'just-me' && door === null && (
        <div className="sos-door sos-door-bad" role="alert">
          <span className="sos-door-g">◆</span>
          <span className="sos-door-s">{MKT_SERVE['mkt.serve.no-orch']}</span>
        </div>
      )}
      <span className="sos-note">{MKT_SERVE['mkt.serve.reversible']}</span>
    </div>
  )
}
