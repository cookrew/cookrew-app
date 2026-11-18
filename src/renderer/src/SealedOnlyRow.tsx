// THE SEALED-ONLY ROW in ⋯ (owner ruling 2026-11-19: off by default, a switch the owner flips).
// On, this Mac answers nothing sent in the clear over the relay: only sealed sessions, the direct
// link and its own screen reach it. Phones, consoles and watches not on the sealed session yet are
// shut out while it is on, so the row says so. Only where the bridge has the call (this Mac).
import { useEffect, useState } from 'react'
import { cookrew } from './api'
import { CrIcon } from './icons'

export const SEALED_ONLY_NOTE = 'Refuse everything sent unencrypted through the relay. Older phones, consoles and watches cannot reach this computer through the relay while it is on, and a watch cannot pair through the relay.'

export function SealedOnlyRowView({ on, onToggle }: { on: boolean; onToggle: () => void }): React.JSX.Element {
  return (
    <button type="button" className={`cr-more-item tall${on ? ' on' : ''}`} aria-pressed={on} onClick={onToggle}>
      <CrIcon name="dot" />
      <span className="cr-more-text">
        <span className="cr-more-label">{on ? 'Relay: sealed only' : 'Relay: sealed only off'}</span>
        <span className="cr-more-note">{SEALED_ONLY_NOTE}</span>
      </span>
    </button>
  )
}

export function SealedOnlyRow(): React.JSX.Element | null {
  const [on, setOn] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    void cookrew()
      .sealedOnly?.()
      .then((next) => alive && setOn(next))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])
  if (on === null) return null
  return (
    <SealedOnlyRowView
      on={on}
      onToggle={() => {
        // Turning it on shuts out every phone, console and watch not on the sealed session yet: asked first.
        if (!on && typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(SEALED_ONLY_NOTE)) return
        void cookrew()
          .setSealedOnly?.(!on)
          .then(setOn)
          .catch(() => undefined)
      }}
    />
  )
}
