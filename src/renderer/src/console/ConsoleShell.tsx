import { Component, Suspense, lazy, useEffect, useState, useSyncExternalStore } from 'react'
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

/**
 * The machine level is a chunk fetched when it is wanted. One that will not come (the network,
 * or a build replaced since this page loaded) must not take the whole page down with it: it is
 * said, with the one thing to do.
 */
class ChunkBoundary extends Component<{ onBack: () => void; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <main className="cd-page">
        <p className="cd-line" role="alert">
          This machine’s view could not be loaded. Cookrew may have been updated since this page was opened.
        </p>
        <p className="cd-gate-ways">
          <button type="button" className="cd-primary" onClick={() => window.location.reload()}>
            Reload
          </button>
          <button type="button" className="cd-quiet" onClick={this.props.onBack}>
            Back to your machines
          </button>
        </p>
      </main>
    )
  }
}

export function ConsoleShell({ parts }: { parts: ConsoleParts }): React.JSX.Element | null {
  const { runtime, session } = parts
  const state = useSyncExternalStore(runtime.subscribe, runtime.get, runtime.get)
  const who = useSyncExternalStore(session.subscribe, session.get, session.get)

  useEffect(() => {
    if (who.status === 'signed-in') void loadMachine().catch(() => undefined)
  }, [who.status])

  const { view } = state
  // Finding out who is signed in: the page is there, and says nothing it does not know yet.
  if (view.kind === 'starting') {
    return (
      <main className="cd-page cd-signin" aria-busy="true">
        <h1 className="cd-mark">Cookrew</h1>
      </main>
    )
  }
  if (view.kind === 'sign-in') return <SignIn parts={parts} notice={state.notice} />
  if (view.kind === 'machine') {
    return (
      <ChunkBoundary key={view.machine} onBack={() => runtime.leave()}>
        <Suspense fallback={<p className="cd-opening" role="status">Opening…</p>}>
          <ConsoleMachine machine={view.machine} parts={parts} />
        </Suspense>
      </ChunkBoundary>
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
