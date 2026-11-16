import { useCallback, useEffect, useState } from 'react'
import { cookrew } from '../api'
import { SHARE_COPY } from '../../../shared/account-guide-copy'
import { DEFAULT_DAILY_USD, type SharedKey, type ShareWhere } from '../../../shared/share-devices'

/**
 * SHARE WITH MY DEVICES: this computer's Magpie for the owner's other computers
 * (main/route/share-keys.ts). One key per device, a daily cap on each, revoked
 * here. The key arrives once, in the answer to "Make a key", and is held only
 * until Done: it is for the owner to copy to the other device.
 */

interface Issued {
  key: string
  device: string
}

type Answer<T> = ({ ok: true } & T) | { ok: false; why?: string; reason?: string }

const problemOf = (answer: { ok: false; why?: string; reason?: string }): string => answer.why ?? answer.reason ?? SHARE_COPY.UNAVAILABLE

export function ShareDevicesView({
  keys,
  where,
  problem,
  issued,
  busy,
  onIssue,
  onRevoke,
  onCheck,
  onDone
}: {
  keys: readonly SharedKey[]
  where: ShareWhere | null
  problem: string | null
  issued: Issued | null
  busy: boolean
  onIssue: (device: string, dailyUsd: number) => void
  onRevoke: (id: string) => void
  onCheck: () => void
  onDone: () => void
}): React.JSX.Element {
  const [device, setDevice] = useState('')
  const [daily, setDaily] = useState(String(DEFAULT_DAILY_USD))
  const [copied, setCopied] = useState(false)
  return (
    <div className="cr-routing-share">
      <div className="cr-routing-seg">{SHARE_COPY.HEAD}</div>
      <p className="small">{SHARE_COPY.LEDE}</p>
      {where && !where.onNetwork && (
        <p className="cr-routing-bad">
          {SHARE_COPY.OFF_NETWORK}{' '}
          <button type="button" className="cr-routing-btn" onClick={onCheck}>
            {SHARE_COPY.CHECK}
          </button>
        </p>
      )}
      {where && (
        <p className="small">
          {SHARE_COPY.ADDRESSES}: {where.urls.length > 0 ? where.urls.map((url) => <code key={url}>{url} </code>) : SHARE_COPY.NO_ADDRESS}
        </p>
      )}
      {where && where.urls.length > 0 && <p className="small" data-note="plain-http">{SHARE_COPY.PLAIN}</p>}
      {problem && (
        <p className="cr-routing-bad" role="alert">
          {problem}
        </p>
      )}
      {issued ? (
        <div className="cr-share-key" role="status">
          <b>{issued.device}</b>
          <code className="cr-share-secret">{issued.key}</code>
          <small>{SHARE_COPY.KEY_ONCE}</small>
          <span>
            <button
              type="button"
              className="cr-routing-btn primary"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(issued.key)
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false))
              }}
            >
              {copied ? SHARE_COPY.COPIED : SHARE_COPY.COPY}
            </button>{' '}
            <button
              type="button"
              className="cr-routing-btn"
              onClick={() => {
                setCopied(false)
                onDone()
              }}
            >
              {SHARE_COPY.DONE}
            </button>
          </span>
        </div>
      ) : (
        <form
          className="cr-share-form"
          onSubmit={(e) => {
            e.preventDefault()
            onIssue(device, Number(daily))
          }}
        >
          <label>
            <span className="small">{SHARE_COPY.DEVICE}</span>
            <input name="device" value={device} placeholder={SHARE_COPY.DEVICE_HINT} spellCheck={false} autoComplete="off" onChange={(e) => setDevice(e.target.value)} />
          </label>
          <label>
            <span className="small">{SHARE_COPY.DAILY}</span>
            <input name="daily" inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} />
          </label>
          <button type="submit" className="cr-routing-btn primary" disabled={busy}>
            {busy ? SHARE_COPY.ISSUING : SHARE_COPY.ISSUE}
          </button>
        </form>
      )}
      {keys.length === 0 ? (
        <p className="small">{SHARE_COPY.NONE}</p>
      ) : (
        <ul className="cr-share-keys">
          {keys.map((k) => (
            <li key={k.id}>
              <b>{k.device}</b> <span className="small">{k.limit ?? ''}</span>{' '}
              <button type="button" className="cr-routing-btn" onClick={() => onRevoke(k.id)}>
                {SHARE_COPY.REVOKE}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Absent where the bridge has no share channels: the phone and an older desktop. */
export function ShareDevices(): React.JSX.Element | null {
  const bridge = cookrew()
  const [keys, setKeys] = useState<readonly SharedKey[]>([])
  const [where, setWhere] = useState<ShareWhere | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [issued, setIssued] = useState<Issued | null>(null)
  const [busy, setBusy] = useState(false)
  const read = useCallback(() => {
    void bridge
      .routeShareList?.()
      .then((answer: Answer<{ keys: readonly SharedKey[]; where: ShareWhere }>) => {
        if (!answer.ok) return setProblem(problemOf(answer))
        setProblem(null)
        setKeys(answer.keys)
        setWhere(answer.where)
      })
      .catch(() => setProblem(SHARE_COPY.UNAVAILABLE))
  }, [bridge])
  useEffect(() => read(), [read])
  if (typeof bridge.routeShareList !== 'function') return null
  return (
    <ShareDevicesView
      keys={keys}
      where={where}
      problem={problem}
      issued={issued}
      busy={busy}
      onCheck={read}
      onDone={() => setIssued(null)}
      onIssue={(device, dailyUsd) => {
        setBusy(true)
        void bridge
          .routeShareIssue?.({ device, dailyUsd })
          .then((answer: Answer<{ key: string; shared: SharedKey }>) => {
            if (!answer.ok) return setProblem(problemOf(answer))
            setProblem(null)
            setIssued({ key: answer.key, device: answer.shared.device })
            read()
          })
          .catch(() => setProblem(SHARE_COPY.UNAVAILABLE))
          .finally(() => setBusy(false))
      }}
      onRevoke={(id) => {
        void bridge
          .routeShareRevoke?.(id)
          .then((answer: Answer<object>) => {
            if (!answer.ok) setProblem(problemOf(answer))
            read()
          })
          .catch(() => setProblem(SHARE_COPY.UNAVAILABLE))
      }}
    />
  )
}
