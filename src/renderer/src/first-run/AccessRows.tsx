import { useEffect, useRef, useState } from 'react'
import { cookrew } from '../api'
import { rememberHarness } from '../prompt/harness-pref'
import { ENDPOINT_COPY } from '../../../shared/first-run-copy'
import { thirdPartyAnthropic, type AccessActive, type AccessKeyStore, type AccessProtocol, type AccessRow, type AccessState, type EndpointField } from '../../../shared/agent-access'
import './first-run.css'

/**
 * THE ROAD FOR A PERSON WITH NO CLAUDE OR CODEX ACCOUNT. One row per way in, read
 * off the state main sends: "Use Cookrew credits" is one more row there, and
 * nothing here changes. The key lives in this component only until the save
 * answers; main keeps it and no screen sees it again. What the form says of where
 * it is kept comes from main too, as what is true on this computer.
 */

export interface EndpointForm {
  protocol: AccessProtocol
  baseUrl: string
  key: string
  model: string
  simple: boolean
}

const EMPTY: EndpointForm = { protocol: 'anthropic', baseUrl: '', key: '', model: '', simple: false }

/** What is saved, as the form opens on it. The key never comes back: empty keeps it. */
export const editForm = ({ protocol, baseUrl, model, simple }: AccessActive): EndpointForm => ({ protocol, baseUrl, key: '', model, simple })

export function EndpointFormView({
  form,
  editing = false,
  keyStore = 'file',
  busy,
  problem,
  problemField = null,
  onChange,
  onSave,
  onCancel
}: {
  form: EndpointForm
  /** A saved endpoint is being changed. */
  editing?: boolean
  /** Where a pane's copy of the key is, on this computer. */
  keyStore?: AccessKeyStore
  busy: boolean
  problem: string | null
  /** The field it is about: the words go under it, and it takes the focus. */
  problemField?: EndpointField | null
  onChange: (next: EndpointForm) => void
  onSave: () => void
  onCancel: () => void
}): React.JSX.Element {
  const formRef = useRef<HTMLFormElement>(null)
  // The form is long and the page scrolls: a sentence off screen is no sentence.
  useEffect(() => {
    if (problem === null) return
    const named = problemField === null ? null : formRef.current?.querySelector<HTMLInputElement>(`[name="${problemField}"]`)
    named?.focus({ preventScroll: true })
    formRef.current?.querySelector('.fr-error')?.scrollIntoView({ block: 'center' })
  }, [problem, problemField])
  const wrong = (field: EndpointField): React.JSX.Element | null =>
    problem !== null && problemField === field ? (
      <span className="fr-error" role="alert">
        {problem}
      </span>
    ) : null
  const text = (field: 'baseUrl' | 'model', label: string, placeholder: string): React.JSX.Element => (
    <label className="fr-field">
      <span>{label}</span>
      <input name={field} aria-invalid={problemField === field} value={form[field]} placeholder={placeholder} spellCheck={false} autoComplete="off" onChange={(e) => onChange({ ...form, [field]: e.target.value })} />
      {wrong(field)}
    </label>
  )
  const protocol = (value: AccessProtocol, label: string): React.JSX.Element => (
    <button type="button" className={`fr-protocol${form.protocol === value ? ' on' : ''}`} aria-pressed={form.protocol === value} onClick={() => onChange({ ...form, protocol: value })}>
      {label}
    </button>
  )
  return (
    <form
      ref={formRef}
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
        <input type="password" name="key" aria-invalid={problemField === 'key'} value={form.key} spellCheck={false} autoComplete="off" onChange={(e) => onChange({ ...form, key: e.target.value })} />
        {wrong('key')}
        <small>{editing ? `${ENDPOINT_COPY.KEY_KEEP} ${ENDPOINT_COPY.KEY_NOTE[keyStore]}` : ENDPOINT_COPY.KEY_NOTE[keyStore]}</small>
      </label>
      {text('model', ENDPOINT_COPY.MODEL, ENDPOINT_COPY.MODEL_HINT)}
      {form.protocol === 'anthropic' && thirdPartyAnthropic(form.baseUrl) && (
        <div className="fr-third-party">
          <p>{ENDPOINT_COPY.THIRD_PARTY}</p>
          <label className="fr-check">
            <input type="checkbox" checked={form.simple} onChange={(e) => onChange({ ...form, simple: e.target.checked })} />
            <span>
              {ENDPOINT_COPY.SIMPLE}
              <small>{ENDPOINT_COPY.SIMPLE_NOTE}</small>
            </span>
          </label>
        </div>
      )}
      {problem && (problemField === null || problemField === 'protocol') && (
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
  note = null,
  onOpen,
  onEdit,
  onRemove,
  children
}: {
  state: AccessState
  /** Draw only a source already on: the way to change it, and nothing new for anyone else. */
  whenActive?: boolean
  /** One thing to say under the row. */
  note?: string | null
  onOpen: (row: AccessRow) => void
  onEdit?: (active: AccessActive) => void
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
          {onEdit && (
            <button type="button" className="fr-fix" onClick={() => onEdit(active)}>
              {ENDPOINT_COPY.EDIT}
            </button>
          )}
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
      {note && <p className="fr-why">{note}</p>}
      {children}
    </div>
  )
}

/** Absent where main has no such bridge: the phone adds no endpoint. */
export function AccessRows({ onChange, whenActive = false }: { onChange?: () => void; whenActive?: boolean }): React.JSX.Element | null {
  const [state, setState] = useState<AccessState | null>(null)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<EndpointForm>(EMPTY)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [problemField, setProblemField] = useState<EndpointField | null>(null)
  const [note, setNote] = useState<string | null>(null)
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
    setProblemField(null)
    try {
      const answer = await cookrew().accessSave?.(form)
      if (!answer) return
      if (!answer.ok) {
        setProblemField(answer.field)
        return setProblem(answer.why)
      }
      setState(answer.state)
      setNote(answer.moved ? ENDPOINT_COPY.MOVED : null)
      const [tool] = answer.state.active?.tools ?? []
      if (tool) rememberHarness(tool)
      setForm(EMPTY)
      setOpen(false)
      setEditing(false)
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
    <AccessRowsView
      state={state}
      whenActive={whenActive}
      note={note}
      onOpen={() => setOpen(true)}
      onEdit={(active) => {
        // What the form says of the key is read now: a launch may have fallen back to the file.
        void cookrew()
          .accessState?.()
          .then(setState)
          .catch(() => undefined)
        setForm(editForm(active))
        setEditing(true)
        setOpen(true)
      }}
      onRemove={remove}
    >
      {open && (
        <EndpointFormView
          form={form}
          editing={editing}
          keyStore={state.keyStore}
          busy={busy}
          problem={problem}
          problemField={problemField}
          onChange={setForm}
          onSave={() => void save()}
          onCancel={() => {
            setOpen(false)
            setEditing(false)
            setForm(EMPTY)
            setProblem(null)
            setProblemField(null)
          }}
        />
      )}
    </AccessRowsView>
  )
}
