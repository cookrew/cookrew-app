import { useEffect, useMemo, useRef, useState } from 'react'
import { parseCallerKey, type CallerKeyResult } from '../../shared/caller-key'
import { fingerprintOfDigest, type KeyFingerprint } from '../../shared/key-fingerprint'
import { clearsFieldOn, pasteMessage } from './grant-copy'

/**
 * ENROL A CALLER (deck §3) — one sheet, one act.
 *
 * WHY THE BUTTON SAYS "I COMPARED THESE". The UI cannot verify that this is the
 * key the owner meant; only the human comparison can, and it happens on a
 * channel we have no access to. Typing the words back would prove only that the
 * owner can read OUR screen, which an attacker supplying the key is delighted
 * for them to do. So the friction is not a puzzle, it is an ATTESTATION: the
 * label states the claim the click makes. "Confirm" collects a reflex; this
 * collects a statement, and an owner who has not compared has to knowingly
 * assert something false. That is the strongest thing a UI can do here, and
 * pretending otherwise would be the real defect.
 *
 * THE PRIMARY IS NOT FOCUSED ON OPEN AND ENTER DOES NOT FIRE IT. Enrolment is
 * irreversible in the sense that matters, so it is a deliberate pointer act —
 * the same rule the wallet sheet uses for money. A Magpie gate asserts this by
 * driving the real surface, so it is implemented here rather than described.
 *
 * FINISHING THIS SHEET GRANTS NOTHING. It creates a caller with zero agents.
 * The dangerous half is granting, and it must not ride in on the momentum of a
 * sheet the owner was already completing.
 */

/** WebCrypto, because the sheet must speak the phrase before anything is stored. */
async function fingerprintOf(raw: Uint8Array): Promise<KeyFingerprint> {
  const digest = await crypto.subtle.digest('SHA-256', raw as unknown as ArrayBuffer)
  return fingerprintOfDigest(new Uint8Array(digest))
}

export interface EnrolSubmission {
  sub: string
  jwk: Record<string, unknown>
}

export function EnrolSheet({
  onEnrol,
  onClose,
  /** Subjects already enrolled, for the duplicate lookup (deck §4, row 5). */
  existing = [],
  busy = false,
  error = null
}: {
  onEnrol: (submission: EnrolSubmission) => void
  onClose: () => void
  existing?: readonly { sub: string; keyFingerprint: string }[]
  busy?: boolean
  error?: string | null
}): React.JSX.Element {
  const [pasted, setPasted] = useState('')
  const [name, setName] = useState('')
  const [fingerprint, setFingerprint] = useState<KeyFingerprint | null>(null)
  const keyInput = useRef<HTMLTextAreaElement>(null)

  // Focus the FIRST FIELD, never the primary. See the header note.
  useEffect(() => {
    keyInput.current?.focus()
  }, [])

  const parsed: CallerKeyResult | null = useMemo(
    () => (pasted.trim().length === 0 ? null : parseCallerKey(pasted)),
    [pasted]
  )

  useEffect(() => {
    if (!parsed?.ok) {
      setFingerprint(null)
      return
    }
    let live = true
    void fingerprintOf(parsed.raw).then((fp) => {
      if (live) setFingerprint(fp)
    })
    return () => {
      live = false
    }
  }, [parsed])

  const refusal = parsed && !parsed.ok ? parsed.refusal : null
  const message = refusal ? pasteMessage(refusal) : null

  // A private key is the one refusal that clears the field — leaving it on
  // screen is the harm continuing after we have named it.
  useEffect(() => {
    if (refusal && clearsFieldOn(refusal)) setPasted('')
  }, [refusal])

  const ready = parsed?.ok === true && name.trim().length > 0 && fingerprint !== null && !busy

  const submit = (): void => {
    if (!ready || !parsed?.ok) return
    onEnrol({ sub: name.trim(), jwk: parsed.jwk })
  }

  return (
    <div className="gs-scrim" role="dialog" aria-modal="true" aria-label="Enrol a caller">
      <div
        className="gs-sheet"
        // ENTER DOES NOT FIRE THE PRIMARY. Deliberately not a <form>: a form
        // submits on Enter from any field, which is exactly the reflex this
        // sheet exists to refuse.
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
      >
        <header className="gs-sheet-head">
          <h2>Enrol a caller</h2>
          <button className="gs-x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <p className="gs-sub">They will be able to call only the agents you tick next.</p>

        <label className="gs-label" htmlFor="gs-key">
          Their public key
        </label>
        <textarea
          id="gs-key"
          ref={keyInput}
          className={`gs-input gs-key${refusal ? ' gs-bad' : ''}`}
          value={pasted}
          spellCheck={false}
          autoComplete="off"
          rows={3}
          placeholder="ed25519:MCowBQYDK2VwAyEA…"
          onChange={(e) => setPasted(e.target.value)}
        />
        <p className="gs-hint">paste, or scan a QR</p>

        {message && (
          <p
            className={`gs-paste-error${refusal?.reason === 'private' ? ' gs-loud' : ''}`}
            data-copy-id={message.id}
            role="alert"
          >
            {message.text}
          </p>
        )}

        <label className="gs-label" htmlFor="gs-name">
          Name them
        </label>
        <input
          id="gs-name"
          className="gs-input"
          value={name}
          autoComplete="off"
          placeholder="Kestrel (Ana's instance)"
          onChange={(e) => setName(e.target.value)}
        />

        {/*
          THE COMPARISON. Rendered large, because it is read aloud — six words
          in three seconds, confirmed with certainty. The hex underneath is the
          same 66 bits for anyone who prefers to compare text.
        */}
        {fingerprint && (
          <section className="gs-fp" aria-label="Key fingerprint">
            <p className="gs-fp-cap">CHECK THIS MATCHES WHAT THEY SEE</p>
            <div className="gs-fp-body">
              <p className="gs-fp-words">
                <span>{fingerprint.words.slice(0, 3).join(' · ')}</span>
                <span>{fingerprint.words.slice(3).join(' · ')}</span>
              </p>
              <p className="gs-fp-hex">
                <span>{fingerprint.hex.slice(0, 8)}</span>
                <span>{fingerprint.hex.slice(8, 16)}</span>
                <span className="gs-fp-hexcap">same thing, in hex</span>
              </p>
            </div>
          </section>
        )}

        {error && (
          <p className="gs-paste-error gs-loud" role="alert">
            {error}
          </p>
        )}

        <footer className="gs-sheet-foot">
          <button className="gs-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="gs-primary"
            disabled={!ready}
            // Pointer act only. No autoFocus, and not a form submit button.
            onClick={submit}
          >
            {busy ? 'ENROLLING…' : 'I COMPARED THESE · ENROL'}
          </button>
        </footer>
        <p className="gs-foot-note">
          Enrolling grants nothing — {name.trim() || 'they'} will start with no agents.
        </p>
        {existing.length > 0 && (
          <p className="gs-foot-note gs-dim">{existing.length} already enrolled</p>
        )}
      </div>
    </div>
  )
}
