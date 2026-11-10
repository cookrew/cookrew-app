import { Suspense, lazy, useEffect, useState, useSyncExternalStore } from 'react'
import type { ConsoleParts } from './console-wiring'
import { ConsoleDevicesView } from './ConsoleDevicesView'
import './console.css'

/**
 * THE CONSOLE'S ONE PAGE. What it shows is decided elsewhere
 * (console-navigator.ts); this draws it: the way in, the account's machines
 * with the gate over them, or one machine. A machine is the whole app, as a
 * phone has always seen it, and is a chunk of its own: the machines level
 * loads and paints without it.
 */

// Asked for when the page knows it will be wanted (signed in), not when a machine is first opened.
const loadMachine = (): Promise<typeof import('./ConsoleMachine')> => import('./ConsoleMachine')
const ConsoleMachine = lazy(loadMachine)

export function ConsoleShell({ parts }: { parts: ConsoleParts }): React.JSX.Element | null {
  const { runtime, session } = parts
  const state = useSyncExternalStore(runtime.subscribe, runtime.get, runtime.get)
  const who = useSyncExternalStore(session.subscribe, session.get, session.get)

  useEffect(() => {
    if (who.status === 'signed-in') void loadMachine().catch(() => undefined)
  }, [who.status])

  const { view } = state
  if (view.kind === 'starting') return null
  if (view.kind === 'sign-in') return <SignIn parts={parts} notice={state.notice} />
  if (view.kind === 'machine') {
    return (
      <Suspense fallback={<p className="cd-opening" role="status">Opening…</p>}>
        <ConsoleMachine key={view.machine} machine={view.machine} parts={parts} />
      </Suspense>
    )
  }
  return <ConsoleDevicesView parts={parts} view={view} notice={state.notice} username={who.status === 'signed-in' ? who.username : ''} />
}

function SignIn({ parts, notice }: { parts: ConsoleParts; notice: string | null }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [line, setLine] = useState<string | null>(null)
  const go = async (): Promise<void> => {
    setBusy(true)
    setLine(null)
    const started = await parts.runtime.signIn().catch(() => ({ ok: false as const, message: 'Sign-in could not start. Try again in a moment.' }))
    // Started, the browser is on its way to the sign-in page: the button stays as it is.
    if (!started.ok) {
      setLine(started.message)
      setBusy(false)
    }
  }
  return (
    <main className="cd-page cd-signin">
      <h1 className="cd-mark">Cookrew</h1>
      <p className="cd-lead">Your machines and their agents, from any browser.</p>
      <button type="button" className="cd-primary" disabled={busy} onClick={() => void go()}>
        Sign in
      </button>
      {(line ?? notice) && (
        <p className="cd-line" role="status">
          {line ?? notice}
        </p>
      )}
    </main>
  )
}
