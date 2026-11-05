import { useEffect, useState } from 'react'
import { cookrew } from '../api'
import { rememberHarness } from '../prompt/harness-pref'
import { ENDPOINT_COPY } from '../../../shared/first-run-copy'
import type { AccessProtocol, AccessRow, AccessState } from '../../../shared/agent-access'
import './first-run.css'

/**
 * THE ROAD FOR A PERSON WITH NO CLAUDE OR CODEX ACCOUNT. One row per way in, read
 * off the state main sends: "Use Cookrew credits" is one more row there, and
 * nothing here changes. The key lives in this component only until the save
 * answers; main seals it and no screen sees it again.
 */

export interface EndpointForm {
  protocol: AccessProtocol
  baseUrl: string
  key: string
  model: string
}

const EMPTY: EndpointForm = { protocol: 'anthropic', baseUrl: '', key: '', model: '' }

export function EndpointFormView({
  form,
  busy,
  problem,
  onChange,
  onSave,
  onCancel
}: {
  form: EndpointForm
  busy: boolean
  problem: string | null
  onChange: (next: EndpointForm) => void
  onSave: () => void
  onCancel: () => void
}): React.JSX.Element {
  const text = (field: 'baseUrl' | 'model', label: string, placeholder: string): React.JSX.Element => (
    <label className="fr-field">
      <span>{label}</span>
      <input value={form[field]} placeholder={placeholder} spellCheck={false} autoComplete="off" onChange={(e) => onChange({ ...form, [field]: e.target.value })} />
    </label>
  )
  const protocol = (value: AccessProtocol, label: string): React.JSX.Element => (
    <button type="button" className={`fr-protocol${form.protocol === value ? ' on' : ''}`} aria-pressed={form.protocol === value} onClick={() => onChange({ ...form, protocol: value })}>
      {label}
    </button>
  )
  return (
    <form
      className="fr-endpoint"
      onSubmit={(e) => {
        e.preventDefault()
        onSave()
      }}
    >
      <div className="fr-protocols">
        {protocol('anthropic', ENDPOINT_COPY.ANTHROPIC)}
        {protocol('openai', ENDPOINT_COPY.OPENAI)}
      </div>
      {text('baseUrl', ENDPOINT_COPY.URL, ENDPOINT_COPY.URL_HINT)}
      <label className="fr-field">
        <span>{ENDPOINT_COPY.KEY}</span>
        <input type="password" value={form.key} spellCheck={false} autoComplete="off" onChange={(e) => onChange({ ...form, key: e.target.value })} />
        <small>{ENDPOINT_COPY.KEY_NOTE}</small>
      </label>
      {text('model', ENDPOINT_COPY.MODEL, ENDPOINT_COPY.MODEL_HINT)}
      {problem && (
        <p className="fr-error" role="alert">
          {problem}
        </p>
      )}
      <div className="fr-foot">
        <button type="submit" className="fr-go" disabled={busy}>
          {busy ? ENDPOINT_COPY.SAVING : ENDPOINT_COPY.SAVE}
        </button>
        <button type="button" className="fr-quiet" onClick={onCancel}>
          {ENDPOINT_COPY.CANCEL}
        </button>
      </div>
    </form>
  )
}

export function AccessRowsView({
  state,
  whenActive = false,
  onOpen,
  onRemove,
  children
}: {
  state: AccessState
  /** Draw only a source already on: the way to change it, and nothing new for anyone else. */
  whenActive?: boolean
  onOpen: (row: AccessRow) => void
  onRemove: () => void
  /** The open row's form. */
  children?: React.ReactNode
}): React.JSX.Element | null {
  const { active } = state
  if (whenActive && !active) return null
  return (
    <div className="fr-access">
      <h2 className="fr-access-head">{ENDPOINT_COPY.HEAD}</h2>
      {active ? (
        <div className="fr-access-row">
          <span className="fr-tool">
            <b>
              {ENDPOINT_COPY.ON} {active.host}
            </b>
            <small>
              {active.model} · {active.tools.join(' or ')}
            </small>
          </span>
          <button type="button" className="fr-fix" onClick={onRemove}>
            {ENDPOINT_COPY.REMOVE}
          </button>
        </div>
      ) : (
        state.rows.map((row) => (
          <div key={row.id} className="fr-access-row">
            <span className="fr-tool">
              <b>{row.title}</b>
              <small>{row.does}</small>
            </span>
            <button type="button" className="fr-fix" onClick={() => onOpen(row)}>
              {ENDPOINT_COPY.SAVE_ROW}
            </button>
          </div>
        ))
      )}
      {children}
    </div>
  )
}

/** Absent where main has no such bridge: the phone adds no endpoint. */
export function AccessRows({ onChange, whenActive = false }: { onChange?: () => void; whenActive?: boolean }): React.JSX.Element | null {
  const [state, setState] = useState<AccessState | null>(null)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<EndpointForm>(EMPTY)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void cookrew()
      .accessState?.()
      .then((next) => live && setState(next))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  if (state === null) return null
  const save = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      const answer = await cookrew().accessSave?.(form)
      if (!answer) return
      if (!answer.ok) return setProblem(answer.why)
      setState(answer.state)
      const [tool] = answer.state.active?.tools ?? []
      if (tool) rememberHarness(tool)
      setForm(EMPTY)
      setOpen(false)
      onChange?.()
    } catch {
      setProblem(ENDPOINT_COPY.FAILED)
    } finally {
      setBusy(false)
    }
  }
  const remove = (): void => {
    void cookrew()
      .accessClear?.()
      .then((next) => {
        setState(next)
        onChange?.()
      })
      .catch(() => setProblem(ENDPOINT_COPY.FAILED))
  }
  return (
    <AccessRowsView state={state} whenActive={whenActive} onOpen={() => setOpen(true)} onRemove={remove}>
      {open && (
        <EndpointFormView
          form={form}
          busy={busy}
          problem={problem}
          onChange={setForm}
          onSave={() => void save()}
          onCancel={() => {
            setOpen(false)
            setForm(EMPTY)
            setProblem(null)
          }}
        />
      )}
    </AccessRowsView>
  )
}
