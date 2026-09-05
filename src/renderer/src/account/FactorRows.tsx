import type { FactorsView } from '../../../shared/account-approvals'
import { factorRows, passkeyElsewhere, removeFactorPrompt, type FactorRow } from './account-store'

/**
 * THE FACTOR LADDER'S ROWS (D3), as pixels only.
 *
 * Split out of the card so both of its states can be PAINTED IN A TEST: an
 * account with nothing enrolled and an account with a passkey and an
 * authenticator are two different promises about how the owner gets back in,
 * and the difference between them lives entirely in this markup. A component
 * whose second state only exists after an effect has resolved is a component
 * whose second state is never checked.
 */

export function Row({
  kind,
  label,
  state,
  action,
  saved = false,
}: {
  kind: string
  label: string
  state?: string
  action: React.ReactNode
  /** The RESCUE row's tick, once the owner says they wrote the codes down. */
  saved?: boolean
}): React.JSX.Element {
  return (
    <li className="cr-acct-secrow">
      <span className="cr-acct-kind">{kind}</span>
      <span className="cr-acct-seclabel">{label}</span>
      {state && (
        <span className="cr-acct-secstate">
          {saved && <span aria-hidden="true">✓ </span>}
          {state}
        </span>
      )}
      {action}
    </li>
  )
}

export function FactorRows({
  factors,
  busy = false,
  elsewhere = false,
  onAdd,
  onRemove,
  onOpenBrowser,
}: {
  factors: FactorsView | null
  busy?: boolean
  /** This build refused to make a passkey; the row offers the browser (D3). */
  elsewhere?: boolean
  onAdd: (row: FactorRow) => void
  onRemove: (row: FactorRow) => void
  onOpenBrowser: (url: string) => void
}): React.JSX.Element {
  const browser = passkeyElsewhere(factors?.registry ?? '')
  return (
    <>
      {factorRows(factors).map((row) => (
        <Row
          key={`${row.factor}-${row.id}`}
          kind="FACTOR"
          label={row.label}
          state={row.state}
          action={
            row.action === 'add' ? (
              <button className="gs-ghost" disabled={busy} onClick={() => onAdd(row)}>
                ADD
              </button>
            ) : (
              <button className="gs-revoke" onClick={() => onRemove(row)}>
                REMOVE
              </button>
            )
          }
        />
      ))}
      {elsewhere && (
        <li className="cr-acct-secrow cr-acct-elsewhere">
          <span className="cr-acct-seclabel">{browser.note}</span>
          <button className="gs-ghost" onClick={() => onOpenBrowser(browser.url)}>
            OPEN
          </button>
        </li>
      )}
    </>
  )
}

/**
 * THE PASSWORD A REMOVAL COSTS (registry: removeFactor).
 *
 * Its own component for the same reason the rows are: this appears only after
 * a press, and a state that can only be reached by an event is a state nobody
 * ever paints in a test. The two answers are weighted against the damage —
 * REMOVE IT is the danger colour and KEEP IT is the way out.
 */
export function RemoveFactorRow({
  row,
  current,
  busy = false,
  onCurrent,
  onConfirm,
  onCancel,
}: {
  row: FactorRow
  current: string
  busy?: boolean
  onCurrent: (value: string) => void
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <li className="cr-acct-secrow cr-acct-removefactor">
      <label className="gs-label" htmlFor="cr-acct-factorpass">
        {removeFactorPrompt(row)}
      </label>
      <input
        id="cr-acct-factorpass"
        type="password"
        className="gs-input"
        autoComplete="current-password"
        value={current}
        onChange={(e) => onCurrent(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onConfirm()}
      />
      <button className="gs-revoke" disabled={busy || current.length === 0} onClick={onConfirm}>
        REMOVE IT
      </button>
      <button className="gs-ghost" onClick={onCancel}>
        KEEP IT
      </button>
    </li>
  )
}
