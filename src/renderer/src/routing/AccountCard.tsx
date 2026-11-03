import type { RouteQuota } from '../../../shared/route'
import { maskAccount } from '../../../shared/route-view'
import { quotaFacts, windowView } from '../../../shared/quota-view'

/**
 * ONE ACCOUNT, EVERY WINDOW (route program, Magpie settings).
 *
 * A subscription shows each of its windows as a bar with what is left, when
 * it resets, and roughly how many tokens that is (quota-view.ts); a prepaid
 * provider shows its balance; a row the gateway could not read shows the
 * sentence it gave. The account's own facts (reset credits, plan end, how
 * old the reading is) sit under the windows.
 */
export function AccountCard({ q, now }: { q: RouteQuota; now: number }): React.JSX.Element {
  const sub = [maskAccount(q.account), q.plan].filter((x): x is string => typeof x === 'string' && x.length > 0).join(' · ')
  const facts = quotaFacts(q, now)
  return (
    <div className="cr-routing-acct">
      <div className="cr-routing-acct-h">
        <b>{q.alias ?? q.provider}</b>
        {sub && <span className="small">{sub}</span>}
        <span className="sp" />
        <span className={`cr-routing-tick ${q.error ? 'dim' : 'ok'}`}>{q.kind}</span>
      </div>
      <AccountBody q={q} now={now} />
      {facts.length > 0 && <div className="cr-routing-acct-f small">{facts.join(' · ')}</div>}
    </div>
  )
}

function AccountBody({ q, now }: { q: RouteQuota; now: number }): React.JSX.Element {
  // The gateway could not read this one: the sentence, no bar.
  if (q.error) return <div className="cr-routing-bad" style={{ padding: 0 }}>{q.error}</div>
  if (q.kind === 'local') return <div className="small">local · free</div>
  if (q.kind === 'balance') {
    return (
      <div className="cr-routing-bal">
        <b>{q.balance ?? '—'}</b> <span className="small">prepaid balance</span>
      </div>
    )
  }
  if (q.windows.length === 0) return <div className="small">{q.kind === 'key' ? 'key · no allowance to read' : 'no allowance read yet'}</div>
  return (
    <>
      {q.windows.map((w) => (
        <WindowRow key={w.name} view={windowView(w, now)} />
      ))}
    </>
  )
}

function WindowRow({ view }: { view: ReturnType<typeof windowView> }): React.JSX.Element {
  const detail = [view.tokens ?? view.note, view.value].filter((x): x is string => x !== null)
  return (
    <div className={`cr-routing-win${view.hot ? ' hot' : ''}`}>
      <span className="n">{view.name}</span>
      <span className="b">{view.leftFill !== null && <i style={{ width: `${Math.round(view.leftFill * 100)}%` }} />}</span>
      <span className="l">{view.left}</span>
      <span className="r">{view.resets ?? ''}</span>
      {detail.length > 0 && <span className="t">{detail.join(' · ')}</span>}
    </div>
  )
}
