// THE VAULT IN A SECRET NOTE (owner, 2026-11-05: "like a note you can edit, a
// vault table inside"). The note's words read as a note; its slots stand under
// them as one table, a row per name. The slot block before it drew each secret
// twice, a chip and a form, and said the same three sentences on every one.
//
// A row is one line at rest. A value is pasted straight into its cell and Enter
// seals it, so SEAL and the served box only appear once there is a value. The
// value goes to the store and nowhere else, and nothing sends it back: a sealed
// row says so in words, with its field empty (shared/secret-slot.ts).
//
// There is no delete here, by ruling: a secret goes with its note, from the
// note's close dialog (ConfirmClose.tsx). Renaming is not here either: a value
// never reaches a page, so a page cannot carry it to a new name.
//
// `[data-secret-slot="<name>"]` is the DOM hook the inbox and 🔒+ land on
// (nodes/secret-focus.ts); the first input under it is the row's value.

import { useEffect, useRef, useState } from 'react'
import { cookrew } from '../api'
import { CrIcon } from '../icons'
import { afterSeal, vaultAdd, type SecretListing } from '../../../shared/secret-slot'
import { SECRET_SLOT_COPY, defaultPut, sealedWhen } from './SecretSlot'

type Put = (name: string, value: string, served: boolean) => Promise<SecretListing>

const reasonOf = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason))

export function VaultRow({
  name,
  entry,
  onSealed,
  put = defaultPut
}: {
  name: string
  entry: SecretListing | null
  onSealed?: (entry: SecretListing) => void
  put?: Put
}): React.JSX.Element {
  const [value, setValue] = useState('')
  // Null until touched: the store's flag arrives after the row does.
  const [picked, setPicked] = useState<boolean | null>(null)
  const served = picked ?? entry?.served === true
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const seal = (): void => {
    if (busy || value.length === 0) return
    setBusy(true)
    setError(null)
    put(name, value, served)
      .then((sealed) => {
        // The value is gone from this page the moment the store has it.
        const next = afterSeal(sealed, new Map())
        setValue(next.field.value)
        setError(next.field.error)
        setPicked(null)
        onSealed?.(sealed)
      })
      .catch((reason: unknown) => setError(reasonOf(reason)))
      .finally(() => setBusy(false))
  }

  const state = entry ? `${SECRET_SLOT_COPY.set} · ${sealedWhen(entry.updatedAt)}${entry.served ? ' · served' : ''}` : SECRET_SLOT_COPY.empty
  return (
    <div className={`cr-vault-row${entry ? ' sealed' : ''}`} role="row" data-secret-slot={name}>
      <span className="cr-vault-name" role="cell">
        <CrIcon name="lock" />
        <b>{name}</b>
      </span>
      <span className="cr-vault-value" role="cell">
        <input
          type="password"
          className="cr-secret-slot-input"
          aria-label={`${SECRET_SLOT_COPY.secret} ${name}`}
          autoComplete="off"
          value={value}
          // Never dots: an empty field must LOOK empty, or the reader cannot
          // tell a sealed value from a typed one.
          placeholder={entry ? 'sealed · paste to replace' : 'paste the secret'}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // Keys typed here are the row's, not the terminal's or the zoom's.
            e.stopPropagation()
            if (e.key === 'Enter') {
              e.preventDefault()
              seal()
            }
            if (e.key === 'Escape') setValue('')
          }}
        />
        {value.length > 0 && (
          <button type="button" className="cr-btn sm cr-secret-slot-seal" disabled={busy} onClick={seal}>
            {busy ? SECRET_SLOT_COPY.sealing : SECRET_SLOT_COPY.seal}
          </button>
        )}
      </span>
      <span className={`cr-vault-state${error ? ' error' : ''}`} role="cell">
        {error ?? state}
      </span>
      {value.length > 0 && (
        <label className="cr-vault-served">
          <input type="checkbox" checked={served} onChange={(e) => setPicked(e.target.checked)} />
          <span>{SECRET_SLOT_COPY.served}</span>
        </label>
      )}
    </div>
  )
}

/** The last row: closed it is one quiet button; open it takes a name, and a value if there is one yet. */
function VaultAdd({
  names,
  sealed,
  put,
  onSealed,
  onAddSlot,
  reread
}: {
  names: readonly string[]
  sealed: ReadonlyMap<string, SecretListing>
  put: Put
  onSealed: (entry: SecretListing) => void
  onAddSlot: (name: string) => Promise<void>
  /** The store's names as they stand now: the table's listing is only as old as the table. */
  reread: () => Promise<readonly string[]>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [raw, setRaw] = useState('')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const plan = vaultAdd({ raw, value, sealed: [...sealed.keys()], held: names })
  const close = (): void => {
    setOpen(false)
    setRaw('')
    setValue('')
    setError(null)
  }

  const add = async (): Promise<void> => {
    if (busy || !plan.ok || plan.name === null) return
    setBusy(true)
    setError(null)
    try {
      // Asked again at the moment of the act: another note, or the phone, may
      // have sealed this name since, and a put here would overwrite it.
      const now = vaultAdd({ raw, value, sealed: await reread(), held: names })
      if (!now.ok) return setError(now.hint)
      // The store first: a row must not promise a value that was refused.
      if (value.length > 0) {
        const row = await put(plan.name, value, false)
        setValue('')
        onSealed(row)
      }
      await onAddSlot(plan.name)
      close()
    } catch (reason) {
      setError(reasonOf(reason))
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="cr-vault-add"
        onClick={() => {
          setOpen(true)
          void reread().catch(() => undefined)
        }}
      >
        + add secret
      </button>
    )
  }
  const keys = (e: React.KeyboardEvent): void => {
    e.stopPropagation()
    if (e.key === 'Escape') close()
    if (e.key === 'Enter') {
      e.preventDefault()
      void add()
    }
  }
  return (
    <div className="cr-vault-row new" role="row">
      <span className="cr-vault-name" role="cell">
        <CrIcon name="lock" />
        <input
          type="text"
          aria-label="The secret's name"
          placeholder="name"
          autoFocus
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value)
            setError(null)
          }}
          onKeyDown={keys}
        />
      </span>
      <span className="cr-vault-value" role="cell">
        <input type="password" aria-label="The secret's value" placeholder="value, or fill it in later" autoComplete="off" value={value} onChange={(e) => {
          setValue(e.target.value)
          setError(null)
        }} onKeyDown={keys} />
        <button type="button" className="cr-btn sm" disabled={busy || !plan.ok} onClick={() => void add()}>
          ADD
        </button>
      </span>
      <span className={`cr-vault-state${error ? ' error' : ''}`} role="cell">
        {error ?? plan.hint}
      </span>
    </div>
  )
}

export interface VaultTableProps {
  names: readonly string[]
  sealed: ReadonlyMap<string, SecretListing>
  /** The note can take a new line, and the listing was read: without it a new row could overwrite a sealed name. */
  canAdd: boolean
  put?: Put
  onSealed: (entry: SecretListing) => void
  onAddSlot: (name: string) => Promise<void>
  reread?: () => Promise<readonly string[]>
}

/** The table, from what is already known: the whole of it draws without a bridge. */
export function VaultTable({ names, sealed, canAdd, put = defaultPut, onSealed, onAddSlot, reread = async () => [...sealed.keys()] }: VaultTableProps): React.JSX.Element {
  return (
    <div className="cr-vault" role="table" aria-label="Sealed secrets" onDoubleClick={(e) => e.stopPropagation()}>
      <div className="cr-vault-head" role="row">
        <span role="columnheader">{SECRET_SLOT_COPY.name}</span>
        <span role="columnheader">VALUE</span>
        <span role="columnheader">STATE</span>
      </div>
      {names.map((name) => (
        <VaultRow key={name} name={name} entry={sealed.get(name) ?? null} put={put} onSealed={onSealed} />
      ))}
      {canAdd && <VaultAdd names={names} sealed={sealed} put={put} onSealed={onSealed} onAddSlot={onAddSlot} reread={reread} />}
      <p className="cr-vault-how">{SECRET_SLOT_COPY.how}</p>
    </div>
  )
}

/** The table on the store's listing: names and dates, never values. */
export function SecretVault({
  names,
  canAdd,
  onAddSlot
}: {
  names: readonly string[]
  canAdd: boolean
  onAddSlot: (name: string) => Promise<void>
}): React.JSX.Element {
  const [sealed, setSealed] = useState<ReadonlyMap<string, SecretListing>>(new Map())
  const [read, setRead] = useState(false)
  const live = useRef(true)
  const reread = async (): Promise<readonly string[]> => {
    const list = cookrew().secretList
    if (!list) throw new Error('this bridge has no secrets store')
    const rows = await list()
    if (live.current) {
      setSealed(new Map(rows.map((row) => [row.name, row])))
      setRead(true)
    }
    return rows.map((row) => row.name)
  }
  useEffect(() => {
    live.current = true
    void reread().catch(() => undefined)
    return () => {
      live.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <VaultTable
      names={names}
      sealed={sealed}
      canAdd={canAdd && read}
      onSealed={(entry) => setSealed((prev) => afterSeal(entry, prev).listing)}
      onAddSlot={onAddSlot}
      reread={reread}
    />
  )
}
