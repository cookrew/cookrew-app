import { useState } from 'react'
import { REMOTE_COPY } from '../../../shared/account-guide-copy'
import { checkRemoteMagpie, type RemoteField } from '../../../shared/remote-magpie'
import type { RunOptions } from './use-setup-terminal'

/**
 * Another computer's Magpie, as one provider of this one's (shared/remote-magpie.ts).
 * Two fields, no key: the line is typed into the Setup terminal ending at `key=`
 * and the person pastes the key there. Nothing here holds it.
 */
export function RemoteMagpieForm({ onRun, onCancel }: { onRun: (line: string, options?: RunOptions) => void; onCancel?: () => void }): React.JSX.Element {
  const [address, setAddress] = useState('')
  const [name, setName] = useState('')
  const [problem, setProblem] = useState<{ field: RemoteField; why: string } | null>(null)
  const [typed, setTyped] = useState(false)
  const wrong = (field: RemoteField): React.JSX.Element | null =>
    problem?.field === field ? (
      <span className="fr-error" role="alert">
        {problem.why}
      </span>
    ) : null
  return (
    <form
      className="fr-endpoint cr-remote-magpie"
      onSubmit={(e) => {
        e.preventDefault()
        const checked = checkRemoteMagpie({ address, name })
        if (!checked.ok) {
          setProblem({ field: checked.field, why: checked.why })
          return
        }
        setProblem(null)
        setTyped(true)
        onRun(checked.line, { enter: false })
      }}
    >
      <label className="fr-field">
        <span>{REMOTE_COPY.ADDRESS}</span>
        <input name="address" aria-invalid={problem?.field === 'address'} value={address} placeholder={REMOTE_COPY.ADDRESS_HINT} spellCheck={false} autoComplete="off" onChange={(e) => setAddress(e.target.value)} />
        {wrong('address')}
        <small>{REMOTE_COPY.ADDRESS_WHERE}</small>
      </label>
      <label className="fr-field">
        <span>{REMOTE_COPY.NAME}</span>
        <input name="name" aria-invalid={problem?.field === 'name'} value={name} placeholder={REMOTE_COPY.NAME_HINT} spellCheck={false} autoComplete="off" onChange={(e) => setName(e.target.value)} />
        {wrong('name')}
        <small>{REMOTE_COPY.NAME_NOTE}</small>
      </label>
      {typed && (
        <p className="fr-note" role="status">
          {REMOTE_COPY.PASTE}
        </p>
      )}
      <div className="fr-foot">
        <button type="submit" className="fr-go">
          {REMOTE_COPY.CONNECT}
        </button>
        {onCancel && (
          <button type="button" className="fr-quiet" onClick={onCancel}>
            {REMOTE_COPY.CANCEL}
          </button>
        )}
      </div>
    </form>
  )
}
