import type { RefObject } from 'react'
import type { ClaimFields, FieldView, MigrateView, RegisterView, SignInView } from './account-store'

/**
 * THE ACCOUNT SHEET'S THREE PANES — pixels only.
 *
 * Every word and every verdict on these panes comes in through a view from
 * account-store.ts; nothing here decides anything. The panes exist as their
 * own file so AccountSheet.tsx is the state machine and nothing else, and so
 * the same field row is drawn once for all three states rather than three
 * times slightly differently.
 */

/** A field, its verdict beside it, and the reason under it. */
function FieldRow({
  id,
  label,
  view,
  children,
}: {
  id: string
  label: string
  view: FieldView
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <>
      <label className="gs-label" htmlFor={id}>
        {label}
      </label>
      <div className="cr-acct-row">
        {children}
        <span className={`cr-acct-tag cr-acct-${view.tone}`}>{view.tag}</span>
      </div>
      {view.note.length > 0 && <p className={`gs-hint cr-acct-${view.tone}`}>{view.note}</p>}
    </>
  )
}

export interface UsernameProps {
  value: string
  view: FieldView
  onChange: (next: string) => void
  /** The first field takes the focus — the same rule the import sheet keeps. */
  field?: RefObject<HTMLInputElement>
}

/**
 * The name, typed. Label is "Username" — not "Username or email" until email
 * exists (D9), because a label that names a field nobody can fill is a lie
 * told on every open.
 */
export function UsernameField({ value, view, onChange, field }: UsernameProps): React.JSX.Element {
  return (
    <FieldRow id="cr-acct-username" label="Username" view={view}>
      <input
        id="cr-acct-username"
        ref={field}
        className={`gs-input${view.tone === 'bad' ? ' gs-bad' : ''}`}
        value={value}
        spellCheck={false}
        autoComplete="username"
        placeholder="@drej"
        onChange={(e) => onChange(e.target.value)}
      />
    </FieldRow>
  )
}

/**
 * The create side's password and its repeat (D2's second half), shared with
 * the legacy state, which is exactly this and nothing above it.
 */
export function PasswordPair({
  fields,
  password,
  confirm,
  onChange,
  onEnter,
  field,
}: {
  fields: { password: string; confirm: string }
  password: FieldView
  confirm: FieldView
  onChange: (next: { password: string; confirm: string }) => void
  onEnter: () => void
  field?: RefObject<HTMLInputElement>
}): React.JSX.Element {
  return (
    <>
      <FieldRow id="cr-acct-password" label="Password" view={password}>
        <input
          id="cr-acct-password"
          type="password"
          ref={field}
          className={`gs-input${password.tone === 'bad' ? ' gs-bad' : ''}`}
          value={fields.password}
          autoComplete="new-password"
          onChange={(e) => onChange({ ...fields, password: e.target.value })}
        />
      </FieldRow>
      <div className="cr-acct-row">
        <input
          type="password"
          aria-label="Repeat the password"
          className={`gs-input${confirm.tone === 'bad' ? ' gs-bad' : ''}`}
          value={fields.confirm}
          autoComplete="new-password"
          onChange={(e) => onChange({ ...fields, confirm: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && onEnter()}
        />
        <span className={`cr-acct-tag cr-acct-${confirm.tone}`}>{confirm.tag}</span>
      </div>
      {confirm.note.length > 0 && (
        <p className={`gs-hint cr-acct-${confirm.tone}`}>{confirm.note}</p>
      )}
    </>
  )
}

/** SIGN IN (D9): the name, the password, and nothing measured. */
export function SignInPane({
  fields,
  view,
  onChange,
  onEnter,
  field,
}: {
  fields: { username: string; password: string }
  view: SignInView
  onChange: (next: { username: string; password: string }) => void
  onEnter: () => void
  field?: RefObject<HTMLInputElement>
}): React.JSX.Element {
  return (
    <>
      <p className="gs-consequence cr-acct-lede">{view.lede}</p>
      <UsernameField
        value={fields.username}
        view={view.username}
        field={field}
        onChange={(username) => onChange({ ...fields, username })}
      />
      <FieldRow id="cr-acct-password" label="Password" view={view.password}>
        <input
          id="cr-acct-password"
          type="password"
          className="gs-input"
          value={fields.password}
          autoComplete="current-password"
          onChange={(e) => onChange({ ...fields, password: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && onEnter()}
        />
      </FieldRow>
    </>
  )
}

/** CREATE ACCOUNT (D9): D2's fields under the create lede. */
export function RegisterPane({
  fields,
  view,
  onChange,
  onEnter,
  field,
}: {
  fields: ClaimFields
  view: RegisterView
  onChange: (next: ClaimFields) => void
  onEnter: () => void
  field?: RefObject<HTMLInputElement>
}): React.JSX.Element {
  return (
    <>
      <p className="gs-consequence cr-acct-lede">{view.lede}</p>
      <UsernameField
        value={fields.username}
        view={view.username}
        field={field}
        onChange={(username) => onChange({ ...fields, username })}
      />
      <PasswordPair
        fields={fields}
        password={view.password}
        confirm={view.confirm}
        onEnter={onEnter}
        onChange={(next) => onChange({ ...fields, ...next })}
      />
    </>
  )
}

/**
 * LEGACY (phase 6, untouched): the name is a statement, not a field. It is
 * the one the doors are published under, and the only thing missing is a
 * password — so the password IS the first field, and the focus goes there.
 */
export function LegacyPane({
  handle,
  fields,
  view,
  onChange,
  onEnter,
  field,
}: {
  handle: string
  fields: { password: string; confirm: string }
  view: MigrateView
  onChange: (next: { password: string; confirm: string }) => void
  onEnter: () => void
  field?: RefObject<HTMLInputElement>
}): React.JSX.Element {
  return (
    <>
      <label className="gs-label">Username</label>
      <div className="cr-acct-row">
        <input
          id="cr-acct-username"
          className="gs-input"
          value={`@${handle}`}
          readOnly
          spellCheck={false}
          aria-readonly="true"
        />
        <span className="cr-acct-tag cr-acct-good">yours ✓</span>
      </div>
      <p className="gs-hint cr-acct-good">{view.lead}</p>
      <PasswordPair
        fields={fields}
        password={view.password}
        confirm={view.confirm}
        onEnter={onEnter}
        onChange={onChange}
        field={field}
      />
    </>
  )
}
