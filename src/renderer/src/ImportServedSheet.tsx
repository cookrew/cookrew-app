import { useEffect, useRef, useState } from 'react'
import { cookrew, type ServeFacePreview } from './api'
import { ImportGate } from './ImportGate'
// The gs-* sheet primitives — stated here, by the component that wears them.
import './grant-surface.css'

/**
 * IMPORT A SERVED TEAM — the import side's one entry.
 *
 * Paste the address the owner copied from their serving card. The sheet reads
 * the team's PUBLIC FACE — what they chose to publish, nothing more — so you
 * see the name, the price and the door before anything commits.
 *
 * IMPORT places ONE card: the team's orch, your interface. The card's pixels
 * are the orch's real terminal, mirrored from the session workspace the
 * author's app mints for you; sign-in happens when the card boots, money (a
 * paid door) is asked for once, in the line, at session start.
 */
export function ImportServedSheet({
  onClose,
  onImported
}: {
  onClose: () => void
  onImported: () => void
}): React.JSX.Element {
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<ServeFacePreview | null>(null)
  /** A paid door hands off to the gate sheet; this is that hand-off. */
  const [gating, setGating] = useState(false)
  const field = useRef<HTMLInputElement>(null)

  // The first field, never the primary — the same rule the enrol sheet keeps.
  useEffect(() => {
    field.current?.focus()
  }, [])

  const REASONS: Record<string, string> = {
    'bad-address': "That doesn't look like a served address.",
    'not-serving': 'Nobody is serving a team at that address.',
    unreachable: "Couldn't reach that address — is the app running and on your network?",
    'desktop-only': 'Served teams can only be imported from the desktop app.'
  }

  const lookUp = (): void => {
    if (busy || link.trim().length === 0) return
    setBusy(true)
    setError(null)
    void cookrew()
      .serveInspect(link.trim())
      .then((result) => {
        setBusy(false)
        if (result.ok) setPreview(result.face)
        else setError(REASONS[result.reason] ?? "Couldn't read that address.")
      })
      .catch((err: unknown) => {
        setBusy(false)
        setError(err instanceof Error ? err.message : String(err))
      })
  }

  /** `paid` comes from the gate; a free door places with none, and none is
   *  not zero — the card must be able to say "free", not "0.00". */
  const place = (paid?: { price: string; asset: string; rail: 'x402' | 'stripe' }): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    void cookrew()
      .serveImport(link.trim(), undefined, paid)
      .then((result) => {
        setBusy(false)
        if (result.ok) onImported()
        else setError(REASONS[result.reason] ?? "Couldn't import that team.")
      })
      .catch((err: unknown) => {
        setBusy(false)
        setError(err instanceof Error ? err.message : String(err))
      })
  }

  /**
   * A PAID door is met at the gate sheet, never in the card's terminal. The
   * money is settled before anything is placed, so the card that lands opens
   * into a session already paid for.
   */
  const importTeam = (): void => {
    if (busy) return
    if (preview?.access === 'paid') {
      setGating(true)
      return
    }
    place()
  }

  const onGateOpen = (paid?: { price: string; asset: string; rail: 'x402' | 'stripe' }): void =>
    place(paid)

  if (gating && preview) {
    return (
      <ImportGate
        link={link.trim()}
        face={preview}
        onOpen={onGateOpen}
        onDismiss={() => setGating(false)}
      />
    )
  }

  return (
    <div className="gs-scrim" role="dialog" aria-modal="true" aria-label="Import a served team">
      <div
        className="gs-sheet gs-small"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
      >
        <header className="gs-sheet-head">
          <h2>Import a team</h2>
          <button className="gs-x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <p className="gs-sub">Paste the address whoever runs it gave you.</p>

        <input
          ref={field}
          className="gs-input"
          value={link}
          spellCheck={false}
          autoComplete="off"
          placeholder="192.168.1.20:8639/research-crew"
          aria-label="Served team address"
          onChange={(e) => {
            setLink(e.target.value)
            setPreview(null)
          }}
          onKeyDown={(e) => e.key === 'Enter' && (preview ? importTeam() : lookUp())}
        />

        {error && (
          <p className="gs-paste-error" role="alert">
            {error}
          </p>
        )}

        {preview && (
          <section className="isv-face" aria-label="Team preview">
            <div className="isv-row">
              <span className="isv-name">{preview.name}</span>
              <span className="cr-chip-ver">V{preview.version}</span>
            </div>
            <div className="isv-row isv-dim">
              <span>
                {preview.access === 'paid'
                  ? `${preview.priceUsd} USD · per session — the next step shows the terms`
                  : 'Free — the card signs you in when it boots'}
              </span>
            </div>
            <div className="isv-row isv-dim">
              <span>
                You talk to <b>{preview.door}</b> — it runs the other {Math.max(preview.agents - 1, 0)}{' '}
                on the owner&apos;s side.
              </span>
            </div>
          </section>
        )}

        <footer className="gs-sheet-foot">
          <button className="gs-ghost" onClick={onClose}>
            Cancel
          </button>
          {preview ? (
            <button className="gs-primary" disabled={busy} onClick={importTeam}>
              {busy
                ? 'PLACING…'
                : preview.access === 'paid'
                  ? 'CONTINUE — REVIEW THE TERMS'
                  : 'IMPORT — PLACE THE ORCH CARD'}
            </button>
          ) : (
            <button
              className="gs-primary"
              disabled={busy || link.trim().length === 0}
              onClick={lookUp}
            >
              {busy ? 'LOOKING…' : 'LOOK UP'}
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}
