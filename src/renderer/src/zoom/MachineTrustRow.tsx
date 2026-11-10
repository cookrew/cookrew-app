import { useEffect, useState } from 'react'
import { hostPlatform } from '../../../shared/machine-words'
import { cookrew } from '../api'
import { machineTrustLine, type MachineTrustState } from './machine-trust'

/** Under the account's other machines while this one cannot read them yet: its one proof, or how to give it. */
/**
 * Has this machine given its one proof. Asked once and again now and then, and
 * shared by the row that offers the proof and by the machines under it, which
 * say why they cannot be read yet (machine-why.ts · machineSays).
 */
export function useMachineTrust(): readonly [MachineTrustState | null, (next: MachineTrustState) => void] {
  const [state, setState] = useState<MachineTrustState | null>(null)
  useEffect(() => {
    let live = true
    const ask = (): void => {
      void (cookrew().machineTrust?.() ?? Promise.resolve(null)).then(
        (next) => {
          if (live) setState(next)
        },
        () => undefined
      )
    }
    ask()
    // A sign-in or an unlock elsewhere can make this machine trusted: look again now and then.
    const timer = setInterval(ask, 30_000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [])
  return [state, setState]
}

export function MachineTrustRow({ others, trust }: { others: number; trust: ReturnType<typeof useMachineTrust> }): React.JSX.Element | null {
  const [state, setState] = trust
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const line = machineTrustLine(state, others, hostPlatform())
  if (line === null) return null
  const prove = (): void => {
    const ask = cookrew().proveMachine
    if (!ask || busy) return
    setBusy(true)
    setFailed(false)
    void ask().then(
      (ok) => {
        setBusy(false)
        if (ok) setState({ trusted: true })
        else setFailed(true)
      },
      () => {
        setBusy(false)
        setFailed(true)
      }
    )
  }
  return (
    <button type="button" className="zv-trust zv-trust-go" onClick={prove} disabled={busy}>
      {busy ? 'Waiting for your sign-in…' : failed ? `${line.text} · try again` : line.text}
    </button>
  )
}
