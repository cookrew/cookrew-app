import { useEffect, useState } from 'react'
import { cookrew } from '../api'
import { afterSeal, type SecretListing } from '../../../shared/secret-slot'

/**
 * THE SEALED SLOT — the only password field in Cookrew (R4).
 *
 * A note line `🔒 <name>` is a slot (shared/secret-slot.ts). In the zoom
 * editor it draws as: the name, a password field, one toggle "served
 * sessions may read" (default off), and SEAL. SEAL hands the value to the
 * store through `secretPut` and to NOTHING else: not the note body, which
 * keeps exactly `🔒 <name>`, not a draft, not a prop. When the store already
 * holds the name the block says "set ✓ · updated <when>" and the field is
 * empty — the value is never sent back to any page.
 *
 * The DOM hook the inbox lands on (Fresco's lane): `[data-secret-slot="<name>"]`
 * with a focusable input, so a `secret.requested` row can open the note and
 * put the cursor in the right field.
 *
 * `served` is a flag with no reader yet (secret-cli.ts refuses every served
 * pane this round); it is kept so the owner's choice survives.
 */

export interface SecretSlotProps {
  readonly name: string
  /** What the store holds for this name, or null when nothing is sealed yet. */
  readonly entry: SecretListing | null
  /** After a seal: the listing the store answered with. */
  readonly onSealed?: (entry: SecretListing) => void
  /** Test seam: the put, so a render needs no bridge. */
  readonly put?: (name: string, value: string, served: boolean) => Promise<SecretListing>
}

export const SECRET_SLOT_COPY = {
  title: 'SEALED SLOT',
  name: 'NAME',
  secret: 'SECRET',
  served: 'served sessions may read',
  off: 'no (default)',
  on: 'yes',
  seal: 'SEAL',
  sealing: 'SEALING…',
  empty: 'not set',
  set: 'set ✓',
  how: 'agents: cookrew secret exec <name> -- <command> — the value is in that command\'s environment and its children inherit it; read prints it into the pane · every read audited',
  where: 'stored on this machine; the phone sends it over TLS — to the desktop directly, or hop by hop through cookrew.dev; the note keeps only the name'
} as const

/** "updated 10:52" — the clock of the seal, never the value. */
export const sealedWhen = (updatedAt: number, now = Date.now()): string => {
  const at = new Date(updatedAt)
  const sameDay = new Date(now).toDateString() === at.toDateString()
  const clock = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  return sameDay ? `updated ${clock}` : `updated ${at.toISOString().slice(0, 10)} ${clock}`
}

const defaultPut = (name: string, value: string, served: boolean): Promise<SecretListing> => {
  const api = cookrew()
  if (!api.secretPut) return Promise.reject(new Error('this bridge has no secrets store'))
  return api.secretPut(name, value, served)
}

export function SecretSlot({ name, entry, onSealed, put = defaultPut }: SecretSlotProps): React.JSX.Element {
  const [value, setValue] = useState('')
  const [served, setServed] = useState(entry?.served === true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const seal = (): void => {
    if (busy || value.length === 0) return
    setBusy(true)
    setError(null)
    put(name, value, served)
      .then((sealed) => {
        // The value is gone from this page the moment the store has it
        // (shared/secret-slot.ts · afterSeal, the step a test can call).
        const next = afterSeal(sealed, new Map())
        setValue(next.field.value)
        setError(next.field.error)
        onSealed?.(sealed)
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setBusy(false))
  }

  const state = entry
    ? `${SECRET_SLOT_COPY.set} · ${sealedWhen(entry.updatedAt)} · served ${entry.served ? '✓' : '✗'}`
    : SECRET_SLOT_COPY.empty

  return (
    <div className="cr-secret-slot nodrag nowheel" data-secret-slot={name}>
      <span className="cr-secret-slot-name">🔒 {name}</span>
      <input
        type="password"
        className="cr-secret-slot-input"
        aria-label={`${SECRET_SLOT_COPY.secret} ${name}`}
        autoComplete="off"
        value={value}
        // Never dots: an empty field after SEAL must LOOK empty, or the
        // reader cannot tell a sealed value from a typed one.
        placeholder={entry ? 'paste to replace' : 'paste the secret'}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') seal()
          e.stopPropagation()
        }}
      />
      <button type="button" className="cr-btn cr-secret-slot-seal" disabled={busy || value.length === 0} onClick={seal}>
        {busy ? SECRET_SLOT_COPY.sealing : SECRET_SLOT_COPY.seal}
      </button>
      <span className="cr-secret-slot-state">{error ?? state}</span>
      <span className="cr-secret-slot-how">{SECRET_SLOT_COPY.how}</span>
      <label className="cr-secret-slot-served">
        <input type="checkbox" checked={served} onChange={(e) => setServed(e.target.checked)} />
        <span>
          {SECRET_SLOT_COPY.served} — {served ? SECRET_SLOT_COPY.on : SECRET_SLOT_COPY.off}
        </span>
      </label>
    </div>
  )
}

/**
 * THE OPEN NOTE'S SLOTS (owner, 2026-11-05): a block per name under the note,
 * and the store's listing — names and dates, never values — read when the
 * block appears and whenever `rereadOn` turns. The canvas card drew these; it
 * is retired, and a slot nobody can fill is a name and nothing else.
 */
export function SecretSlots({ names, rereadOn }: { names: readonly string[]; rereadOn: unknown }): React.JSX.Element {
  const [sealed, setSealed] = useState<ReadonlyMap<string, SecretListing>>(new Map())
  useEffect(() => {
    const api = cookrew()
    if (!api.secretList) return
    let live = true
    void api
      .secretList()
      .then((rows) => {
        if (live) setSealed(new Map(rows.map((row) => [row.name, row])))
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [rereadOn])
  return (
    <div className="cr-secret-slots">
      {names.map((name) => (
        <SecretSlot key={name} name={name} entry={sealed.get(name) ?? null} onSealed={(entry) => setSealed((prev) => afterSeal(entry, prev).listing)} />
      ))}
    </div>
  )
}
