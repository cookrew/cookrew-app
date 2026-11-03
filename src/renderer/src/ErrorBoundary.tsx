import { Component, type ErrorInfo, type ReactNode } from 'react'
import { isChunkLoadError, reloadForNewBuildNow, reportCrash } from './crash-report'

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * The whole app's last line. It still read "Canvas crashed" after the canvas
 * was retired, and its button only re-rendered the same tree, so an error
 * that repeats crashed again at once. It now says what broke, records the
 * error where the owner can read it (crash-report.ts), and RELOADS the page —
 * fresh code and fresh state — with a lighter "try again" beside it.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // A chunk of an older build: load the new one rather than crash.
    if (isChunkLoadError(error) && reloadForNewBuildNow()) return
    reportCrash(error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      if (isChunkLoadError(this.state.error)) {
        return (
          <div className="crash-panel" role="status">
            <h2>Cookrew was updated on the Mac</h2>
            <p className="crash-note">Loading the new version…</p>
            <div className="crash-actions">
              <button type="button" onClick={() => window.location.reload()}>
                Reload
              </button>
            </div>
          </div>
        )
      }
      return (
        <div className="crash-panel" role="alert">
          <h2>Cookrew hit an error</h2>
          <pre>{this.state.error.message}</pre>
          <p className="crash-note">It has been recorded on the Mac. Reloading usually brings Cookrew back.</p>
          <div className="crash-actions">
            <button type="button" onClick={() => window.location.reload()}>
              Reload
            </button>
            <button type="button" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
