import { useEffect, useRef, useState } from 'react'
import { cookrew } from './api'
import type { RemoteCrewView } from './api'
// The gs-* sheet primitives. This import used to arrive via GrantPanel; when
// that panel was retired its CSS left the bundle and this sheet went naked —
// so the dependency is stated HERE, by the component that actually wears it.
import './grant-surface.css'

/**
 * ADD A CREW — the import side's one entry (owner ruling, 2026-08-26).
 *
 * Paste the address the owner copied from their serving card. The sheet reads
 * the crew's PUBLIC FACE — what they chose to publish, nothing more — so you
 * see the name, the price and the door before anything commits.
 *
 * ADDING IS FREE AND INERT. It puts a chip in your dock and does nothing else:
 * no payment, no connection, no session. Commitment happens at the gate, money
 * at the sheet, connection when you place the card — three visible acts, none
 * of which this one performs.
 */
export function AddCrewSheet({
  onClose,
  onAdded
}: {
  onClose: () => void
  onAdded: (crew: RemoteCrewView) => void
}): React.JSX.Element {
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<RemoteCrewView | null>(null)
  const field = useRef<HTMLInputElement>(null)

  // The first field, never the primary — the same rule the enrol sheet keeps.
  useEffect(() => {
    field.current?.focus()
  }, [])

  const REASONS: Record<string, string> = {
    'bad-link': "That doesn't look like a crew address.",
    'not-serving': 'Nobody is serving a crew at that address.',
    unreachable: "Couldn't reach that address — is the app running and on your network?",
    'desktop-only': 'Crews can only be added from the desktop app.'
  }

  const add = (): void => {
    if (busy || link.trim().length === 0) return
    setBusy(true)
    setError(null)
    void cookrew()
      .crewAdd(link.trim())
      .then((result) => {
        setBusy(false)
        if (result.ok) {
          setPreview(result.crew)
          onAdded(result.crew)
        } else {
          setError(REASONS[result.reason] ?? "Couldn't add that crew.")
        }
      })
      .catch((err: unknown) => {
        setBusy(false)
        setError(err instanceof Error ? err.message : String(err))
      })
  }

  return (
    <div className="gs-scrim" role="dialog" aria-modal="true" aria-label="Add a crew">
      <div
        className="gs-sheet gs-small"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
      >
        <header className="gs-sheet-head">
          <h2>Add a crew</h2>
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
          aria-label="Crew address"
          onChange={(e) => setLink(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />

        {error && (
          <p className="gs-paste-error" role="alert">
            {error}
          </p>
        )}

        {preview && (
          <section className="acs-face" aria-label="Crew preview">
            <div className="acs-row">
              <span className="acs-name">{preview.name}</span>
              <span className="cr-chip-ver">V{preview.version}</span>
            </div>
            <div className="acs-row acs-dim">
              <span>
                {preview.access === 'paid'
                  ? `${preview.priceUsd} USDC · per session`
                  : 'Free — sign in and start'}
              </span>
            </div>
            <div className="acs-row acs-dim">
              <span>
                You talk to <b>{preview.door}</b> — it runs the rest of the crew.
              </span>
            </div>
            <p className="gs-foot-note">
              It's in your dock. Nothing is paid and nothing connects until you place it.
            </p>
          </section>
        )}

        <footer className="gs-sheet-foot">
          <button className="gs-ghost" onClick={onClose}>
            {preview ? 'Done' : 'Cancel'}
          </button>
          <button className="gs-primary" disabled={busy || link.trim().length === 0} onClick={add}>
            {busy ? 'LOOKING…' : 'ADD TO DOCK'}
          </button>
        </footer>
      </div>
    </div>
  )
}
