import { Component, ReactNode } from 'react'

interface ErrorBoundaryState {
  error: Error | null
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error): void {
    console.error('[cookrew] canvas crashed:', error)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="crash-panel">
          <h2>Canvas crashed</h2>
          <pre>{this.state.error.message}</pre>
          <button onClick={() => this.setState({ error: null })}>Reload canvas</button>
        </div>
      )
    }
    return this.props.children
  }
}
