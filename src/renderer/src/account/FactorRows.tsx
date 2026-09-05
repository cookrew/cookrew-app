import type { FactorsView } from '../../../shared/account-approvals'
import { factorRows, passkeyElsewhere, type FactorRow } from './account-store'

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
}: {
  kind: string
  label: string
  state?: string
  action: React.ReactNode
}): React.JSX.Element {
  return (
    <li className="cr-acct-secrow">
      <span className="cr-acct-kind">{kind}</span>
      <span className="cr-acct-seclabel">{label}</span>
      {state && <span className="cr-acct-secstate">{state}</span>}
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
